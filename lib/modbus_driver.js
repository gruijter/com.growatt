/*
Copyright 2025 - 2026, Robin de Gruijter (rmdegruijter@gmail.com)

This file is part of com.growatt.

com.growatt is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.growatt is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.growatt.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

/*
 * Pairing and repair of the local Modbus TCP drivers. One file, kept identical (apart from the
 * licence header) in com.solarwatt, com.solaredge, com.foxess and com.growatt: change it in every
 * app at once.
 *
 * Two pairing flows, chosen by the point map:
 * - with `findUnits` (a server with several units, e.g. SolarEdge's inverter, meters, batteries
 *   and followers): the address is looked up (mDNS, else a scan of Homey's subnet) and filled in;
 *   the user confirms or corrects it, then picks from the units found there.
 * - without: Homey's device list of what the driver's mDNS strategy (else the scan) found, one unit
 *   per address, plus an "enter IP address" entry. Repair points the device at another address.
 */

const net = require('node:net');
const Homey = require('homey');
const ModbusClient = require('./ModbusClient');
const ModbusScanner = require('./ModbusScanner');
const ModbusDevice = require('./modbus_device');
const brand = require('./modbusBrand');
const registerCapture = require('./registerCapture');
const { blockKey, readBlock } = require('./registers');

const DEFAULT_POLL_INTERVAL = 5; // seconds

/** Pairing must answer well inside Homey's 30s budget, so probes are kept short. */
const PAIR_TIMEOUT = 4000;
// unit ids after the leader's tried for followers (SolarEdge leader/follower: consecutive ids)
const MAX_FOLLOWERS = 10;

/** data.id of the list entry that stands for "enter an address by hand". */
const MANUAL_ENTRY_ID = 'manual_entry';

module.exports = class ModbusDriver extends Homey.Driver {

  async onInit() {
    this.log(`${this.id} driver has been initialized`);
  }

  get definition() {
    return brand.pointMap[this.id];
  }

  onPair(session) {
    if (this.definition.findUnits) this.pairByAddress(session);
    else this.pairFromList(session);
  }

  normalizeEndpoint({ host, port, unitId }) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) throw Error(this.homey.__('errors.hostRequired'));
    return {
      host: cleanHost,
      port: Number(port) || this.definition.port,
      unitId: Number(unitId) || this.definition.unitId,
    };
  }

  /**
   * Read `blocks` into one address-keyed map, in order (the client keeps `readGapMs` between
   * them); an `optional` block that fails is left out.
   * @returns {Promise<Map<number, number>>}
   */
  async read(client, blocks) {
    const registers = new Map();
    for (const block of blocks) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await readBlock(registers, client, block);
      } catch (error) {
        if (!block.optional || ModbusClient.isConnectError(error)) throw error;
        this.log(`optional block at ${blockKey(block)} failed: ${error.message}`);
      }
    }
    return registers;
  }

  /**
   * What the device's first detection (ModbusDevice.runDetection) will conclude, so a new device
   * starts with its capabilities and needs no migration. undefined when a block that is not
   * `optional` neither answered nor was refused; the device then detects at its start, and no later
   * unit of this pairing tries.
   */
  async pairDetection(client, base, pairing) {
    if (!this.definition.detect) return undefined;
    const registers = new Map();
    const refused = new Set();
    for (const block of this.definition.detectBlocks(base)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await readBlock(registers, client, block);
      } catch (error) {
        if (error instanceof ModbusClient.ModbusException && [1, 2].includes(error.code)) {
          refused.add(blockKey(block));
          continue;
        }
        // left out, as the device's own detection does (readBlocks)
        if (block.optional && !ModbusClient.isConnectError(error)) {
          this.log(`[pair] optional detection block at ${blockKey(block)} failed: ${error.message}`);
          continue;
        }
        this.log(`[pair] detection at ${blockKey(block)} failed: ${error.message}`);
        this.captureRegisters('Detection', registers, base, { refused: [...refused], error: error.message });
        pairing.detect = false; // eslint-disable-line no-param-reassign
        return undefined;
      }
    }
    const detected = this.definition.detect(registers, {}, base, refused);
    this.captureRegisters('Detection', registers, base, { refused: [...refused], detected });
    return detected;
  }

  /** Log what pairing read (Identity, Detection), as ModbusDevice.captureRegisters does. */
  captureRegisters(kind, registers, base, extra) {
    registerCapture.record(`${this.id.replace(/[^A-Za-z]/g, '')}Pair${kind}`, {
      reason: 'pair',
      version: this.homey.manifest.version,
      base,
      registers: registerCapture.toRuns(registers),
      ...extra,
    }, (line) => this.log(line));
  }

  /** The IPv4 address of Homey for a scan of its /24, or null. */
  async scanAddress() {
    const localIp = String(await this.homey.cloud.getLocalAddress()).split(':')[0];
    if (net.isIPv4(localIp)) return localIp;
    this.log(`[pair] no scan: local address ${localIp} is not IPv4`);
    return null;
  }

  // --- pairing by address, then the units there (point map `findUnits`) -------------------

  /** manual (address) -> list_devices (the units found there) -> add_devices. */
  pairByAddress(session) {
    let found = [];
    // started right away, so the result is ready when the view asks for it
    const discovery = this.discover();
    session.setHandler('discover', () => discovery);
    session.setHandler('manual_fields', async () => ({ port: this.definition.port, unitId: this.definition.unitId }));
    session.setHandler('manual_connect', async (data) => {
      found = await this.findDevices(data);
      return found.length;
    });
    session.setHandler('list_devices', async () => found);
  }

  /**
   * Endpoints where this driver finds something to pair, the most likely first: mDNS (point map
   * `mdns`), else every open driver port on Homey's /24, each checked with the driver's own pairing
   * reads. Never rejects.
   * @returns {Promise<Array<{ host: string, port: number, unitId: number, count: number }>>}
   */
  async discover() {
    try {
      const started = Date.now();
      let source = 'mDNS';
      let candidates = this.mdnsCandidates();
      if (candidates.length === 0) {
        source = 'scan';
        candidates = await this.scanCandidates();
      }
      const byHost = new Map();
      for (const endpoint of candidates) byHost.set(endpoint.host, [...(byHost.get(endpoint.host) || []), endpoint]);
      // hosts at once, but a host's ports one after another: it serves one Modbus connection at a
      // time. One entry per host, on the first port that answered (point map `ports` order).
      const checked = await Promise.all([...byHost.values()].map(async (endpoints) => {
        for (const endpoint of endpoints) {
          // eslint-disable-next-line no-await-in-loop
          const devices = await this.findDevicesAt(endpoint, { discovering: true }).catch(() => []);
          if (devices.length) return { ...endpoint, count: devices.length };
        }
        return null;
      }));
      const result = checked.filter(Boolean);
      this.log(`[pair] ${source}: ${candidates.length} candidate(s), ${result.length} found in ${Date.now() - started} ms`,
        result.map((endpoint) => `${endpoint.host}:${endpoint.port}#${endpoint.unitId}`).join(', '));
      return result;
    } catch (error) {
      this.error('discovery failed:', error.message);
      return [];
    }
  }

  /** What the app's mDNS strategy named by point map `mdns` sees, as endpoints. */
  mdnsCandidates() {
    if (!this.definition.mdns) return [];
    let results = [];
    try {
      results = Object.values(this.homey.discovery.getStrategy(this.definition.mdns).getDiscoveryResults());
    } catch (error) {
      this.error('mDNS unavailable:', error.message);
    }
    return results.filter((result) => result.address).map((result) => ({
      host: result.address,
      port: Number(result.port) || this.definition.port,
      unitId: this.announcedUnitId(result),
    }));
  }

  /** The unit id an mDNS announcement names in its TXT record (MODBUS_ID), else the point map's. */
  announcedUnitId(result) {
    const txt = result.txt || {};
    return Number(txt.MODBUS_ID ?? txt.modbus_id) || this.definition.unitId;
  }

  /**
   * Open driver ports on Homey's /24 (IPv4 only). A host the app is already connected to is not
   * probed (a second connection could drop the devices'); its connection is checked instead.
   */
  async scanCandidates() {
    const localIp = await this.scanAddress();
    if (!localIp) return [];
    const ports = this.scanPorts();
    const inUse = this.homey.app.pool.endpoints();
    const open = await ModbusScanner.scan(localIp, ports, { skipHosts: inUse.map(({ host }) => host) });
    // a server's lowest unit id in use, the leader: pairing goes on to its followers from there
    const leaders = new Map();
    for (const endpoint of inUse.filter(({ port }) => ports.includes(port))) {
      const key = `${endpoint.host}:${endpoint.port}`;
      if (!leaders.has(key) || endpoint.unitId < leaders.get(key).unitId) leaders.set(key, endpoint);
    }
    return [
      ...leaders.values(),
      ...open.map(({ host, port }) => ({ host, port, unitId: this.definition.unitId })),
    ];
  }

  scanPorts() {
    return this.definition.ports || [this.definition.port];
  }

  /**
   * The devices this driver can add at an address, ready for list_devices; throws when nothing
   * (suitable) answers there. When the port does not connect, the driver's other standard port
   * (point map `ports`) is tried too.
   */
  async findDevices(fields) {
    const endpoint = this.normalizeEndpoint(fields);
    const ports = [endpoint.port, ...(this.definition.ports || []).filter((port) => port !== endpoint.port)];
    const connectFailures = []; // every port tried, so the message names the one the user entered too
    for (const [index, port] of ports.entries()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.findDevicesAt({ ...endpoint, port });
      } catch (error) {
        const last = index === ports.length - 1;
        this.log(`[pair] ${endpoint.host}:${port}#${endpoint.unitId}: ${error.message}`);
        if (!ModbusClient.isConnectError(error)) {
          if (error.unitsMissing) throw error;
          throw Error(`${this.homey.__('errors.modbusProbeFailed')} (${error.message})`);
        }
        connectFailures.push(error.message);
        if (last) throw Error(`${this.homey.__('errors.modbusProbeFailed')} (${connectFailures.join('; ')})`);
      }
    }
    return [];
  }

  /**
   * findDevices() on one endpoint; a ModbusClient error passes through as it is. Over the pooled
   * connection, so pairing shares the one of a device already paired on that server.
   * @param {object} [options] { discovering }: only on a server the point map's `discoverable` accepts
   */
  async findDevicesAt(endpoint, { discovering = false } = {}) {
    const { pool } = this.homey.app;
    // held until the followers are done: their probes go over this same connection
    pool.acquire({
      ...endpoint, timeout: PAIR_TIMEOUT, gapMs: this.definition.readGapMs, log: (message) => this.log(message),
    });
    // detection for every unit until one times out (Homey ends list_devices at 30 s)
    const pairing = { detect: !discovering };
    let devices;
    try {
      devices = await this.findUnitDevices(endpoint, { discovering, pairing });
      // the inverters behind a leader (point map `followers`), on the next unit ids, until one does
      // not answer; not while discovering, which only counts servers
      if (this.definition.followers && !discovering && devices !== null) {
        for (let unitId = endpoint.unitId + 1; unitId <= endpoint.unitId + MAX_FOLLOWERS; unitId += 1) {
          // eslint-disable-next-line no-await-in-loop
          const found = await this.findUnitDevices({ ...endpoint, unitId }, { pairing }).catch((error) => {
            this.log(`[pair] ${endpoint.host}:${endpoint.port}#${unitId}: ${error.message}`);
            return null;
          });
          if (found === null) break;
          devices.push(...found);
        }
      }
    } finally {
      pool.release(endpoint);
    }

    if (!devices?.length) throw Object.assign(Error(this.homey.__('errors.modbusNoUnits')), { unitsMissing: true });
    return devices;
  }

  /**
   * The devices of one unit id; null when nothing of the brand answers there. A ModbusClient error
   * of the endpoint's own unit passes through.
   */
  async findUnitDevices(endpoint, { discovering = false, pairing = { detect: false } } = {}) {
    const { pool } = this.homey.app;
    const client = pool.acquire({
      ...endpoint, timeout: PAIR_TIMEOUT, gapMs: this.definition.readGapMs, log: (message) => this.log(message),
    });
    // the same blocks once per unit: discoverable, followers and findUnits can all read them
    const reads = new Map();
    const read = (blocks) => {
      const key = JSON.stringify(blocks);
      if (!reads.has(key)) reads.set(key, this.read(client, blocks));
      return reads.get(key);
    };

    const devices = [];
    try {
      if (discovering && this.definition.discoverable && !(await this.definition.discoverable(read))) return [];
      if (this.definition.followers && !(await this.definition.followers(read))) return null;
      const units = await this.definition.findUnits(read);
      for (const { base } of units) {
        // eslint-disable-next-line no-await-in-loop
        const registers = await read(this.definition.identityBlocks(base));
        this.captureRegisters('Identity', registers, base);
        // eslint-disable-next-line no-await-in-loop
        const detected = pairing.detect ? await this.pairDetection(client, base, pairing) : undefined;
        devices.push(this.unitDevice({
          endpoint, base, registers, detected,
        }));
      }
    } finally {
      pool.release(endpoint);
    }
    return devices;
  }

  /** The Homey device object for the unit at `base`, with its capabilities when `detected` is known. */
  unitDevice({
    endpoint, base, registers, detected,
  }) {
    const identity = this.definition.identity(registers, base);
    const name = this.manifest.name[this.homey.i18n.getLanguage()] || this.manifest.name.en;
    return {
      name: `${name} ${identity.serialNumber || endpoint.host}`,
      // without a serial number: the address, with the unit id for a follower
      data: { id: this.definition.dataId(registers, base) || `${endpoint.host}${endpoint.unitId === this.definition.unitId ? '' : `#${endpoint.unitId}`}-${base}` },
      ...(detected ? { capabilities: ModbusDevice.capabilityList(this.definition, detected) } : {}),
      store: detected ? { base, detected } : { base },
      settings: {
        ...endpoint,
        pollInterval: this.definition.pollInterval || DEFAULT_POLL_INTERVAL,
        ...ModbusDevice.identitySettings(identity, this.homey, this.manifest),
      },
    };
  }

  // --- pairing from the driver's own mDNS list (no `findUnits`) ---------------------------

  /** list_devices -> route -> add_devices, or the manual address form. */
  pairFromList(session) {
    let selected = [];
    session.setHandler('list_devices', async () => [...await this.onPairListDevices(), this.manualEntry()]);
    session.setHandler('list_devices_selection', (devices) => {
      selected = devices || [];
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'route') return;
      await session.showView(selected.some(ModbusDriver.isManualEntry) ? 'manual' : 'add_devices');
    });
    session.setHandler('manual_connect', async (data) => this.pairManually(data));
    session.setHandler('manual_fields', async () => ({ unitId: this.definition.usesUnitId }));
  }

  /**
   * Repair points the device at a unit found over mDNS or the scan (current one first) or typed by hand.
   * Another unit is allowed on purpose, e.g. after a replacement.
   */
  onRepair(session, device) {
    let selected = [];
    // a listed unit that could not be taken: the address form opens with it and the reason
    let failed = null;
    session.setHandler('list_devices', async () => [...await this.listUnits(device), this.manualEntry()]);
    session.setHandler('list_devices_selection', (devices) => {
      selected = devices || [];
    });
    session.setHandler('showView', async (viewId) => {
      if (viewId !== 'route') return;
      const [choice] = selected;
      if (!choice || ModbusDriver.isManualEntry(choice)) {
        await session.showView('repair_manual');
        return;
      }
      try {
        await this.moveDevice(device, choice.settings, choice.data.discoveryId);
      } catch (error) {
        this.error('[repair]', error.message);
        failed = { endpoint: choice.settings, error: error.message };
        await session.showView('repair_manual');
        return;
      }
      await session.showView('done');
    });
    session.setHandler('manual_fields', async () => {
      const fields = { unitId: this.definition.usesUnitId, ...failed };
      failed = null;
      return fields;
    });
    session.setHandler('manual_connect', async ({ host, port, unitId }) => {
      const endpoint = this.normalizeEndpoint({ host, port, unitId });
      const discovered = this.discoveryResults().find((result) => result.address === endpoint.host);
      return this.moveDevice(device, endpoint, discovered ? discovered.id : null);
    });
  }

  /** The extra list entry that leads to the address form instead of a discovered device. */
  manualEntry() {
    return { name: this.homey.__('pair.manualEntry'), data: { id: MANUAL_ENTRY_ID } };
  }

  static isManualEntry(device) {
    return Boolean(device && device.data && device.data.id === MANUAL_ENTRY_ID);
  }

  endpointOf(result) {
    return {
      host: result.address,
      port: Number(result.port) || this.definition.port,
      unitId: this.announcedUnitId(result),
    };
  }

  /**
   * Read the identity block, proving something Modbus-speaking is really there and that it
   * carries what this driver is for (a battery, a meter).
   * @param {object} [options] { detect }: also what the device's first detection will conclude
   * @returns {Promise<object>} the identity, with `detected` when asked and read
   */
  async probe({ host, port, unitId }, { detect = false } = {}) {
    // the pool: a server a paired device uses gets no second connection
    const { pool } = this.homey.app;
    const endpoint = { host, port, unitId };
    const client = pool.acquire({
      ...endpoint, timeout: PAIR_TIMEOUT, gapMs: this.definition.readGapMs, log: (message) => this.log(message),
    });

    let registers;
    let detected;
    try {
      registers = await this.read(client, this.definition.identityBlocks(0));
      this.captureRegisters('Identity', registers, 0);
      if (detect) detected = await this.pairDetection(client, 0, { detect: true });
    } catch (error) {
      throw Error(`${this.homey.__('errors.modbusProbeFailed')} (${error.message})`);
    } finally {
      pool.release(endpoint);
    }

    if (this.definition.pairable && !this.definition.pairable(registers)) {
      throw Error(this.homey.__(`errors.notPairable.${this.id}`));
    }
    const identity = this.definition.identity(registers, 0);
    return detected ? { ...identity, detected } : identity;
  }

  /** The endpoint as device settings; without unitId where the driver has no such setting. */
  endpointSettings({ host, port, unitId }) {
    return this.definition.usesUnitId ? { host, port, unitId } : { host, port };
  }

  /** The Homey device object for one discovered or entered endpoint. */
  listedDevice({
    id, endpoint, identity, mdnsName = '',
  }) {
    const label = identity.serialNumber || endpoint.host;
    const { detected } = identity;
    return {
      name: `${this.homey.__(`pair.deviceName.${this.id}`)} ${label}`,
      data: { id },
      ...(detected ? { capabilities: ModbusDevice.capabilityList(this.definition, detected) } : {}),
      store: { unitSerial: identity.unitSerial || '', ...(detected ? { detected } : {}) },
      settings: {
        ...this.endpointSettings(endpoint),
        pollInterval: this.definition.pollInterval || DEFAULT_POLL_INTERVAL,
        mdnsName,
        ...ModbusDevice.identitySettings(identity, this.homey, this.manifest),
      },
    };
  }

  /** Everything the driver's own mDNS strategy currently sees; nothing for a driver without one. */
  discoveryResults() {
    if (!this.manifest.discovery) return [];
    try {
      return Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
    } catch (error) {
      this.error('discovery unavailable:', error.message);
      return [];
    }
  }

  /**
   * Every host on Homey's /24 (IPv4 only) with the Modbus port open, as discovery results
   * without an id. For when mDNS sees nothing, e.g. multicast filtered on the network; a unit
   * on another subnet is not found this way. Never rejects, so the manual entry stays listed.
   */
  async scanResults() {
    try {
      const localIp = await this.scanAddress();
      if (!localIp) return [];
      // a server the app is connected to is not scanned (a second connection), but listed as found
      const ports = this.scanPorts();
      const inUse = this.homey.app.pool.endpoints().filter(({ port }) => ports.includes(port));
      const open = await ModbusScanner.scan(localIp, ports, { skipHosts: inUse.map(({ host }) => host) });
      const servers = new Map([...inUse, ...open].map(({ host, port }) => [`${host}:${port}`, { host, port }]));
      return [...servers.values()].map(({ host, port }) => ({ id: null, address: host, port }));
    } catch (error) {
      this.error('[pair] scan failed:', error.message);
      return [];
    }
  }

  /**
   * Probe every discovery result (else every scan hit), each on its own socket and all at once,
   * so a few silent hosts cannot add up past Homey's 30 s pairing limit.
   * @param {object} [options] { detect }: see probe()
   * @returns {Promise<Array<{ result: object, endpoint: object, identity: object }>>}
   */
  async probeDiscovered({ detect = false } = {}) {
    let source = 'mDNS';
    let results = this.discoveryResults();
    if (results.length === 0) {
      source = 'scan';
      results = await this.scanResults();
    }
    // with the TXT record: what a unit announces (e.g. MODBUS_ID) shows in a diagnostics report
    this.log(`[pair] ${source}: ${results.length} result(s):`, results
      .map((r) => `${r.id || ''}@${r.address}:${r.port}${r.txt ? ` ${JSON.stringify(r.txt)}` : ''}`).join(', '));

    const probed = await Promise.all(results.map(async (result) => {
      const endpoint = this.endpointOf(result);
      try {
        const identity = await this.probe(endpoint, { detect });
        if (!result.id && !ModbusScanner.plausibleSerial(identity.unitSerial)) throw Error('no valid serial number');
        return { result, endpoint, identity };
      } catch (error) {
        // Discovered but not answering our registers: not a device for this driver.
        this.log(`[pair] ${result.id ? `${result.id} at ` : ''}${endpoint.host}: ${error.message}`);
        return null;
      }
    }));
    return probed.filter(Boolean);
  }

  async onPairListDevices() {
    // Homey hides only an entry whose id is a paired device's, so a unit paired under another id
    // (mDNS id, or the manual id of a scan hit or address) by serial number
    const pairedSns = new Set(this.getDevices().map((device) => device.getSetting('deviceSn')).filter(Boolean));
    const units = (await this.probeDiscovered({ detect: true }))
      .filter(({ identity }) => !pairedSns.has(identity.serialNumber));
    return units.map(({ result, endpoint, identity }) => this.listedDevice({
      id: result.id || this.manualId(endpoint, identity), endpoint, identity, mdnsName: result.id || '',
    }));
  }

  /** data.id of a device without a discovery id. */
  manualId(endpoint, identity) {
    return `${this.id}-${identity.serialNumber || endpoint.host}`;
  }

  /** Manual entry. Takes the discovery id when mDNS sees the address, to follow later IP changes. */
  async pairManually({ host, port, unitId }) {
    const endpoint = this.normalizeEndpoint({ host, port, unitId });
    const identity = await this.probe(endpoint, { detect: true });

    const discovered = this.discoveryResults().find((result) => result.address === endpoint.host);
    const id = discovered ? discovered.id : this.manualId(endpoint, identity);

    return this.listedDevice({
      id, endpoint, identity, mdnsName: discovered ? discovered.id : '',
    });
  }

  /** The units repair can offer, as list entries; the one this device uses now first. */
  async listUnits(device) {
    const currentSn = device.getSetting('deviceSn');
    const currentId = device.discoveryId;
    const units = (await this.probeDiscovered()).map(({ result, endpoint, identity }) => {
      const current = (Boolean(currentSn) && identity.serialNumber === currentSn) || result.id === currentId;
      const label = `${identity.serialNumber || endpoint.host} (${endpoint.host})`;
      return {
        name: current ? `${label} - ${this.homey.__('repair.current')}` : label,
        // Not the discovery id itself: the device list hides entries whose data matches an
        // already paired device, and the unit this device uses now is exactly that.
        data: { id: `repair:${result.id || endpoint.host}`, discoveryId: result.id },
        settings: endpoint,
        current,
      };
    });
    return units.sort((a, b) => Number(b.current) - Number(a.current))
      .map(({ current, ...unit }) => unit);
  }

  /** Point an existing device at another endpoint and, with it, possibly another unit. */
  async moveDevice(device, endpoint, discoveryId) {
    const identity = await this.probe(endpoint); // throws if nothing (suitable) answers
    await device.setSettings({ ...this.endpointSettings(endpoint), ...ModbusDevice.identitySettings(identity, this.homey, this.manifest) });
    await device.setStoreValue('unitSerial', identity.unitSerial || '');
    await device.adoptUnit(discoveryId);
    await device.connect();
    await device.poll();
    return true;
  }

};
