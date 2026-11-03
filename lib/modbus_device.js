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
 * The local Modbus TCP devices. One file, kept identical (apart from the licence header) in
 * com.solarwatt, com.solaredge, com.foxess and com.growatt: change it in every app at once. What
 * differs per app is in lib/modbusBrand.js; capabilities, controls and detection come from the
 * point map.
 */

const Homey = require('homey');
const ModbusClient = require('./ModbusClient');
const DeviceMigrator = require('./DeviceMigrator');
const registerCapture = require('./registerCapture');
const brand = require('./modbusBrand');
const { raiseListenerCeiling, saveCounters } = require('./deviceHelpers');
const { blockKey, readBlock, copyBlock } = require('./registers');

const DEFAULT_POLL_INTERVAL = 5; // seconds
const REQUEST_TIMEOUT = 5000;
const OVERRIDE_NOTIFICATION_INTERVAL = 24 * 60 * 60 * 1000; // one timeline note a day at most
const DEFAULT_KEEP_ALIVE = 10; // seconds, for a control that does not set its own

/** An optional block is dropped after this many consecutive failures. */
const OPTIONAL_BLOCK_RETRIES = 3;
/** Consecutive failed polls before the device is marked unavailable. */
const FAILURES_BEFORE_UNAVAILABLE = 3;
/** Once unavailable, a failed poll is logged at most this often. */
const FAILURE_LOG_INTERVAL = 60 * 60 * 1000;
/** Unreachable this long: look for this unit at another address announced over mDNS, then at most this often. */
const REDISCOVER_INTERVAL = 5 * 60 * 1000;
/** A failed identity read is retried at most this often, not every poll. */
const IDENTITY_RETRY_INTERVAL = 5 * 60 * 1000;
/** Re-read this long after a write, so the tile shows what the device actually did. */
const POLL_AFTER_WRITE = 3000;
/** Capability changes within this window reach a control as one set. */
const CONTROL_DEBOUNCE = 300;

module.exports = class ModbusDevice extends Homey.Device {

  async onInit() {
    if (!this.definition) throw Error(`No register map for driver ${this.driver.id}`);

    this.failures = 0;
    this.polling = false;
    this.identityRead = false;
    this.detectionDone = false;
    this.unmappedLogged = new Set();

    this.buildBlocks();
    this.armCapture('device start');

    const migrated = await this.migrate();
    await this.applyCapabilityOptions({ force: migrated });
    if (this.definition.migrateValues) await this.definition.migrateValues(this);
    await this.applyEnergy();
    await this.registerControls();
    await this.connect();
    await this.runDetection();
    this.startPolling();

    this.log(`${this.getName()} has been initialized`);
  }

  get definition() {
    return brand.pointMap[this.driver.id];
  }

  /** The blocks read every poll, for what detect() found (e.g. a battery device's batteries). */
  buildBlocks() {
    // per device: the failure counts must not leak into the shared map
    this.blocks = this.definition.blocks(this.base, this.detected).map((block) => ({ ...block, failures: 0 }));
  }

  /** Register offset of this meter or battery from the first one (pairing, store `base`). */
  get base() {
    return Number(this.getStoreValue('base')) || 0;
  }

  // --- connection ------------------------------------------------------------------------

  get endpoint() {
    const settings = this.getSettings();
    return {
      host: settings.host,
      port: Number(settings.port) || this.definition.port,
      unitId: Number(settings.unitId) || this.definition.unitId,
    };
  }

  /** Take a client from the app-wide pool for the address currently in settings. */
  async connect() {
    const { endpoint } = this;
    if (!endpoint.host) {
      await this.setUnavailable(this.homey.__('errors.hostMissing'));
      return;
    }

    this.release();
    this.client = this.homey.app.pool.acquire({
      ...endpoint,
      timeout: REQUEST_TIMEOUT,
      gapMs: this.definition.readGapMs,
      log: (message) => this.log(message),
    });
    this.connected = endpoint;
  }

  /** Hand the pooled client back, if we hold one. */
  release() {
    if (!this.connected) return;
    this.homey.app.pool.release(this.connected);
    this.connected = null;
    this.client = null;
  }

  // --- discovery -------------------------------------------------------------------------

  /** Off when the user fixed the address: the app then never moves the device. */
  get followsMdns() {
    return this.getSetting('followMdns') !== false;
  }

  /**
   * The mDNS id this device follows, for a driver with its own discovery strategy. It starts as the
   * pairing id; repair can move the device to another unit, and then it follows that one - or
   * nothing ('') after a manual address.
   */
  get discoveryId() {
    const moved = this.getStoreValue('discoveryId');
    return typeof moved === 'string' ? moved : this.getData().id;
  }

  /** Show the mDNS name this device follows on its settings page ('' for a fixed address). */
  async showMdnsName(name) {
    if (this.getSetting('mdnsName') === (name || '')) return;
    await this.setSettings({ mdnsName: name || '' }).catch((error) => this.error(error));
  }

  /** Start over on a (possibly) different unit: new mDNS id, fresh identity and detection. */
  async adoptUnit(discoveryId) {
    await this.setStoreValue('discoveryId', discoveryId || '');
    await this.showMdnsName(discoveryId);
    this.identityRead = false;
    this.identityRetryAt = 0;
    this.detectionRegisters = null;
    // a fresh start: nothing merged from before, and phases may be dropped again
    await this.setStoreValue('detected', {});
    this.buildBlocks();
    this.detectionDone = false;
    this.unmappedLogged = new Set();
    this.armCapture('repair');
  }

  /**
   * Ours when it carries the mDNS id this device follows, or the unit's serial number, which the
   * mDNS id may contain (Solarwatt: mDNS-<SN>.local, EVC-<SN>): that catches a device paired by address.
   */
  onDiscoveryResult(discoveryResult) {
    if (this.discoveryId && discoveryResult.id === this.discoveryId) return true;
    const unitSerial = this.getStoreValue('unitSerial');
    return Boolean(unitSerial) && String(discoveryResult.id).toLowerCase().includes(String(unitSerial).toLowerCase());
  }

  // Typed void, but a throw marks the device unavailable with its message (SDK typings).
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  async onDiscoveryAvailable(discoveryResult) {
    await this.onDiscoveredAt(discoveryResult);
  }

  onDiscoveryAddressChanged(discoveryResult) {
    this.onDiscoveredAt(discoveryResult).catch((error) => this.error(error));
  }

  onDiscoveryLastSeenChanged(discoveryResult) {
    this.onDiscoveredAt(discoveryResult).catch((error) => this.error(error));
  }

  /** Follow the device to a new IP address without losing the Homey device. */
  async onDiscoveredAt({ id, address, port }) {
    if (!address || !this.followsMdns) return;
    if (id && id !== this.discoveryId) {
      this.log(`following mDNS id ${id}`);
      await this.setStoreValue('discoveryId', id).catch((error) => this.error(error));
    }
    if (id) await this.showMdnsName(id);

    const settings = this.getSettings();
    const newPort = Number(port) || settings.port || this.definition.port;
    if (settings.host === address && Number(settings.port) === Number(newPort)) return;

    this.log(`discovered at ${address}:${newPort}, was ${settings.host}:${settings.port}`);
    await this.setSettings({ host: address, port: Number(newPort) }).catch((error) => this.error(error));
    await this.connect();
    await this.poll();
  }

  /**
   * Look for this unit at another address announced over mDNS, for when no discovery event came
   * after it moved (a charger stayed unreachable for days until an app restart).
   */
  async rediscover() {
    if (!this.followsMdns) return;
    if (this.definition.mdns) {
      await this.rediscoverBySerial();
      return;
    }
    const { host } = this.getSettings();
    const result = this.driver.discoveryResults()
      .find((candidate) => candidate.address && candidate.address !== host && this.onDiscoveryResult(candidate));
    if (!result) return;
    this.log(`unreachable at ${host}, mDNS has ${result.id} at ${result.address}`);
    await this.onDiscoveredAt(result);
  }

  /**
   * rediscover() for a point map `mdns` strategy whose announcement does not name the unit: a
   * candidate is this unit when its identity carries the same serial number.
   */
  async rediscoverBySerial() {
    const serialNumber = this.getSetting('deviceSn');
    if (!serialNumber) return;
    const { endpoint } = this;
    const candidates = this.driver.mdnsCandidates().filter((candidate) => candidate.host !== endpoint.host);
    for (const candidate of candidates) {
      const target = { host: candidate.host, port: candidate.port, unitId: endpoint.unitId };
      // the pool: no second connection to a server another device already uses; connect() below
      // takes this same client, so it gets the device's log here
      const client = this.homey.app.pool.acquire({
        ...target, timeout: REQUEST_TIMEOUT, gapMs: this.definition.readGapMs, log: (message) => this.log(message),
      });
      try {
        // eslint-disable-next-line no-await-in-loop
        const registers = await this.driver.read(client, this.definition.identityBlocks(this.base));
        if (this.definition.identity(registers, this.base).serialNumber !== serialNumber) continue;
        this.log(`unreachable at ${endpoint.host}:${endpoint.port}, ${serialNumber} found at ${target.host}:${target.port} over mDNS`);
        // eslint-disable-next-line no-await-in-loop
        await this.setSettings({ host: target.host, port: target.port });
        // eslint-disable-next-line no-await-in-loop
        await this.connect();
        return;
      } catch (error) {
        this.log(`mDNS candidate ${target.host}:${target.port}: ${error.message}`);
      } finally {
        this.homey.app.pool.release(target);
      }
    }
  }

  // --- polling ---------------------------------------------------------------------------

  startPolling() {
    this.stopPolling();
    const seconds = Number(this.getSettings().pollInterval) || this.definition.pollInterval || DEFAULT_POLL_INTERVAL;
    this.pollInterval = this.homey.setInterval(() => {
      this.poll().catch((error) => this.error(error));
    }, seconds * 1000);

    // on their own timer, independent of the update interval
    const keepAliveSeconds = Math.min(...this.controls
      .filter((control) => control.keepAlive)
      .map((control) => (typeof control.keepAliveSeconds === 'function'
        ? control.keepAliveSeconds(this) : control.keepAliveSeconds) || DEFAULT_KEEP_ALIVE));
    if (Number.isFinite(keepAliveSeconds)) {
      this.keepAliveInterval = this.homey.setInterval(() => {
        this.keepAlive().catch((error) => this.error(error));
      }, keepAliveSeconds * 1000);
    }

    // the "Get status update" Flow card
    this.onPollRequested = () => {
      this.poll().catch((error) => this.error(error));
    };
    raiseListenerCeiling(this.homey, brand.pollEvent);
    this.homey.on(brand.pollEvent, this.onPollRequested);

    if (this.definition.showsEnergyManager) {
      this.onEnergyManager = () => {
        this.showEnergyManager().catch((error) => this.error(error));
      };
      raiseListenerCeiling(this.homey, 'energyManager');
      this.homey.on('energyManager', this.onEnergyManager);
    }

    this.poll().catch((error) => this.error(error));
  }

  stopPolling() {
    if (this.pollInterval) this.homey.clearInterval(this.pollInterval);
    if (this.keepAliveInterval) this.homey.clearInterval(this.keepAliveInterval);
    if (this.onPollRequested) this.homey.removeListener(brand.pollEvent, this.onPollRequested);
    if (this.onEnergyManager) this.homey.removeListener('energyManager', this.onEnergyManager);
    this.pollInterval = null;
    this.keepAliveInterval = null;
    this.onPollRequested = null;
    this.onEnergyManager = null;
  }

  async poll() {
    if (this.polling || !this.client) return;
    this.polling = true;
    this.pollStartedAt = Date.now();

    try {
      const registers = await this.readBlocks(this.blocks);
      if (registers.size === 0) throw Error(this.homey.__('errors.modbusNoData'));

      this.failures = 0;
      this.failingSince = null;
      if (!this.getAvailable()) await this.setAvailable();
      await this.handleData(registers);
      await this.reapplyControls(registers);
      this.captureRegisters('Poll', registers, {
        values: Object.fromEntries(this.getCapabilities().map((capability) => [capability, this.getCapabilityValue(capability)])),
      });

      if (!this.identityRead && Date.now() >= (this.identityRetryAt || 0)) await this.readIdentity();
      // only when the device was unreachable during onInit
      if (!this.detectionDone) await this.runDetection();
    } catch (error) {
      this.failures += 1;
      const now = Date.now();
      if (!this.failingSince) this.failingSince = now;
      // unreachable for hours (an inverter off for the night): one line per interval, not per poll
      if (this.failures <= FAILURES_BEFORE_UNAVAILABLE || now - (this.failureLoggedAt || 0) >= FAILURE_LOG_INTERVAL) {
        this.failureLoggedAt = now;
        this.error(`poll ${this.failures} failed:`, error.message);
      }
      if (this.failures === FAILURES_BEFORE_UNAVAILABLE && this.definition.unreachable) {
        // what an unreachable unit stands for (point map `unreachable`), e.g. no solar power
        for (const [capability, value] of Object.entries(this.definition.unreachable(this))) {
          // eslint-disable-next-line no-await-in-loop
          await this.setCapability(capability, value);
        }
      }
      if (this.failures >= FAILURES_BEFORE_UNAVAILABLE) {
        await this.setUnavailable(`${this.homey.__('errors.modbusUnreachable')} ${error.message}`)
          .catch((setError) => this.error(setError));
      }
      if (now - this.failingSince >= REDISCOVER_INTERVAL && now - (this.rediscoveredAt || 0) >= REDISCOVER_INTERVAL) {
        this.rediscoveredAt = now;
        await this.rediscover().catch((rediscoverError) => this.error(rediscoverError));
      }
    } finally {
      this.polling = false;
    }
  }

  /** Wait `ms`, e.g. for a setpoint to take effect. */
  pause(ms) {
    return new Promise((resolve) => {
      this.homey.setTimeout(resolve, ms);
    });
  }

  /**
   * Read every block into one address-keyed map. A failing block only loses its own registers;
   * an `optional` one is no longer read after OPTIONAL_BLOCK_RETRIES failures.
   * @param {object} [options] { refused }: a Set that gets the start of each block the server
   *   answered as absent (Modbus exception 1 or 2), as opposed to one that failed
   * @returns {Promise<Map<number, number>>}
   */
  async readBlocks(blocks, { refused } = {}) {
    const registers = new Map();
    const failed = [];

    for (const block of blocks) {
      if (block.disabled) continue;
      // only for what detect() found, e.g. the inverter's second meter
      if (block.when && !block.when(this.detected)) continue;
      try {
        // sequential: one transaction at a time per server; the client keeps `readGapMs` between them
        // eslint-disable-next-line no-await-in-loop
        await readBlock(registers, this.client, block);
        block.failures = 0;
      } catch (error) {
        // once unavailable, poll() logs the failure itself, throttled
        if (this.failures < FAILURES_BEFORE_UNAVAILABLE) this.log(`block at ${blockKey(block)} failed: ${error.message}`);
        // unreachable: further blocks would only wait out their own timeouts
        if (ModbusClient.isConnectError(error)) break;
        if (refused && error instanceof ModbusClient.ModbusException && [1, 2].includes(error.code)) refused.add(blockKey(block));
        failed.push(block);
      }
    }

    // A failure counts against an optional block only while the rest of the device answers.
    if (registers.size > 0) {
      for (const block of failed) {
        block.failures += 1;
        if (block.optional && block.failures >= OPTIONAL_BLOCK_RETRIES) {
          block.disabled = true;
          this.log(`optional block at ${blockKey(block)} not supported, no longer polling it`);
        }
      }
    }

    return registers;
  }

  /** Log identity, detection and the first poll again, see registerCapture. */
  armCapture(reason) {
    this.captureReason = reason;
    this.captured = new Set();
  }

  /** Log one kind of read (Identity, Detection, Poll) once per armCapture. */
  captureRegisters(kind, registers, extra) {
    if (!this.captureReason || this.captured.has(kind)) return;
    this.captured.add(kind);
    registerCapture.record(`${this.driver.id.replace(/[^A-Za-z]/g, '')}${kind}`, {
      reason: this.captureReason,
      version: this.homey.manifest.version,
      base: this.base,
      registers: registerCapture.toRuns(registers),
      ...extra,
    }, (line) => this.log(line));
  }

  /** Read model/serial/firmware once and mirror them into the device settings page. */
  async readIdentity() {
    try {
      // what detection read moments before is not read again
      const known = this.detectionRegisters;
      this.detectionRegisters = null;
      const registers = new Map();
      const blocks = this.definition.identityBlocks(this.base)
        .filter((block) => !copyBlock(known, registers, block))
        .map((block) => ({ ...block, failures: 0 }));
      for (const [address, word] of await this.readBlocks(blocks)) registers.set(address, word);
      const identity = this.definition.identity(registers, this.base);
      this.captureRegisters('Identity', registers, { identity });
      if (!identity.serialNumber && !identity.model) throw Error(this.homey.__('errors.modbusNoData'));

      await this.setSettings({
        ...ModbusDevice.identitySettings(identity, this.homey, this.driver.manifest),
        ...this.energyManagerSetting(),
      });
      if (identity.unitSerial) await this.setStoreValue('unitSerial', identity.unitSerial);
      this.identityRead = true;
      // the identity can change the energy role, e.g. a meter's function
      await this.applyEnergy();
    } catch (error) {
      this.identityRetryAt = Date.now() + IDENTITY_RETRY_INTERVAL;
      this.error('could not read device identity:', error.message);
    }
  }

  /**
   * The settings-page fields for an identity read, with the driver's own extras: only the keys the
   * driver has as a setting. In `identity.settings` a { i18n: key } is translated and a boolean is a checkbox.
   */
  static identitySettings(identity, homey, driverManifest) {
    const settings = {
      deviceModel: identity.model || '',
      deviceSn: identity.serialNumber || '',
      manufacturer: identity.manufacturer || '',
      firmware: identity.firmware || '',
    };
    for (const [key, value] of Object.entries(identity.settings || {})) {
      if (typeof value === 'boolean') settings[key] = value;
      else settings[key] = value && value.i18n ? homey.__(value.i18n) : (value || '');
    }
    const known = new Set((driverManifest.settings || [])
      .flatMap((setting) => [setting, ...(setting.children || [])])
      .map((setting) => setting.id));
    return Object.fromEntries(Object.entries(settings).filter(([key]) => known.has(key)));
  }

  /** The energy manager the app sees on the network (app `energyManagerLabel`), for drivers whose control it can override. */
  energyManagerSetting() {
    if (!this.definition.showsEnergyManager || typeof this.homey.app.energyManagerLabel !== 'function') return {};
    return { energyManager: this.homey.app.energyManagerLabel() || this.homey.__('settings.energyManagerNone') };
  }

  async showEnergyManager() {
    const setting = this.energyManagerSetting();
    if (setting.energyManager === undefined || setting.energyManager === this.getSetting('energyManager')) return;
    await this.setSettings(setting).catch((error) => this.error(error));
  }

  async handleData(registers) {
    for (const [capability, decode] of Object.entries(this.definition.capabilities)) {
      // no decoder: owned by Homey, written by a control
      if (!decode) continue;
      // some decoders are async, e.g. monotonic() counters
      // eslint-disable-next-line no-await-in-loop
      await this.setCapability(capability, await decode(registers, this));
    }
    // e.g. the charger's card trigger
    if (this.definition.afterData) {
      await this.definition.afterData(registers, this).catch((error) => this.error('after data:', error.message));
    }
  }

  // --- controls --------------------------------------------------------------------------

  /** The point map's controls whose capabilities this device carries. */
  get controls() {
    return (this.definition.controls || [])
      .filter((control) => control.capabilities.every((capability) => this.hasCapability(capability)));
  }

  /**
   * One listener per control, not per capability, so values changed together (SoC window, target
   * power plus mode) are written as one set. Once each: detection can add a control later.
   */
  async registerControls() {
    if (!this.listening) this.listening = new Set();
    for (const control of this.controls) {
      const key = control.capabilities.join(',');
      if (this.listening.has(key)) continue;
      this.listening.add(key);
      const initial = typeof control.initial === 'function' ? control.initial(this) : control.initial;
      for (const [capability, value] of Object.entries(initial || {})) {
        if (this.getCapabilityValue(capability) !== null) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.setCapabilityValue(capability, value).catch((error) => this.error(error));
      }
      // a rejection is shown to the user
      this.registerMultipleCapabilityListener(
        control.capabilities,
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        (values, opts) => this.runControl(control, values, opts),
        CONTROL_DEBOUNCE,
      );
    }
  }

  /**
   * One write of a control at a time, in the order asked: a write reads the control's other
   * capabilities and checks what the device took, which a later write, or a reapply or keep-alive
   * of the previous value, would otherwise change in between.
   */
  async runControl(control, values, opts = {}) {
    // opts tells who asked (app, Flow, Homey itself)
    this.log('control', JSON.stringify(values), JSON.stringify(opts));
    await this.queueControl(control, () => this.writeControl(control, values));
  }

  /** Run `task` after every write, keep-alive and reapply of `control` queued before it. */
  async queueControl(control, task) {
    if (!this.controlRuns) this.controlRuns = new Map();
    const run = (this.controlRuns.get(control) || Promise.resolve())
      .catch(() => {})
      .then(task);
    this.controlRuns.set(control, run);
    try {
      await run;
    } finally {
      if (this.controlRuns.get(control) === run) this.controlRuns.delete(control);
    }
  }

  /** Whether a write of `control` is running or waiting (runControl). */
  controlBusy(control) {
    return Boolean(this.controlRuns?.has(control));
  }

  async writeControl(control, values) {
    if (!this.client) throw Error(this.homey.__('errors.hostMissing'));
    // `refusal`: worded for the user, so a point map action that runs this (runAction) passes it on
    const refusal = control.guard ? await control.guard({ client: this.client, device: this, values }) : null;
    if (refusal) throw Object.assign(Error(this.homey.__(refusal)), { refusal: true });

    // for the point map's override check: a read during a write proves no override
    this.controlsRunning = (this.controlsRunning || 0) + 1;
    try {
      // the user takes control again: reset the override alarm of a watched control
      if (control.watched) await this.clearControlOverridden();
      await control.write({ client: this.client, device: this, values });
    } catch (error) {
      this.error('control failed:', error.message);
      if (error.refusal) throw error; // the device's own answer, already worded for the user
      throw Object.assign(Error(`${this.homey.__('errors.modbusWriteFailed')} ${error.message}`), { refusal: true });
    } finally {
      this.controlsRunning -= 1;
      this.controlEndedAt = Date.now();
    }
    // now, not after the listener returns: a queued write of this control reads them
    for (const [capability, value] of Object.entries(values)) {
      // eslint-disable-next-line no-await-in-loop
      await this.setCapabilityValue(capability, value).catch((error) => this.error(error));
    }

    this.homey.setTimeout(() => {
      this.poll().catch((error) => this.error(error));
    }, POLL_AFTER_WRITE);
  }

  /**
   * Run a control from a Flow action; the new values show right away.
   * @param {object} values capability -> value, all belonging to one control
   */
  async setControl(values) {
    const capabilities = Object.keys(values);
    const control = this.controls.find((candidate) => capabilities.every((cap) => candidate.capabilities.includes(cap)));
    if (!control) throw Error(this.homey.__('errors.notSupported'));
    await this.runControl(control, values);
  }

  /** A one-off command from a Flow action, without a capability (point map `actions`). */
  async runAction(name, args = {}) {
    const action = (this.definition.actions || {})[name];
    if (!action) throw Error(this.homey.__('errors.notSupported'));
    if (!this.client) throw Error(this.homey.__('errors.hostMissing'));
    this.log('action', name, JSON.stringify(args));
    try {
      await action({ client: this.client, device: this, ...args });
    } catch (error) {
      this.error('action failed:', error.message);
      if (error.refusal) throw error;
      throw Error(`${this.homey.__('errors.modbusWriteFailed')} ${error.message}`);
    }
    this.homey.setTimeout(() => {
      this.poll().catch((error) => this.error(error));
    }, POLL_AFTER_WRITE);
  }

  /**
   * Remember what this app wrote, so a decoder can tell when something else changed it.
   * `writeTimes` (not stored) holds each register's last write, also of the same value, for a
   * device that drops a value when no write arrives for a while (point map `changedSince`).
   * @param {object} values register address -> value as written, or null to forget it
   */
  async noteWrites(values) {
    const written = { ...(this.getStoreValue('writtenRegisters') || {}) };
    if (!this.writeTimes) this.writeTimes = {};
    let changed = false;
    for (const [address, value] of Object.entries(values)) {
      if (value === null) delete this.writeTimes[address];
      else this.writeTimes[address] = Date.now();
      if (value === null) {
        if (!(address in written)) continue;
        delete written[address];
      } else {
        // a keep-alive rewriting the same value
        if (written[address] && written[address].value === value) continue;
        written[address] = { value, at: Date.now() };
      }
      changed = true;
    }
    if (changed) await this.setStoreValue('writtenRegisters', written);
    // nothing of ours left to override
    if (Object.keys(written).length === 0) await this.clearControlOverridden();
  }

  /**
   * Another writer changed what this app wrote: latch the alarm and notify on the timeline, at
   * most once a day app-wide (an energy manager keeps taking control back).
   */
  async onControlOverridden() {
    this.log('control overridden by another writer');
    await this.setStoreValue('controlOverridden', true);

    const last = Number(this.homey.settings.get('overrideNotifiedAt')) || 0;
    if (Date.now() - last < OVERRIDE_NOTIFICATION_INTERVAL) return;
    this.homey.settings.set('overrideNotifiedAt', Date.now());
    const manager = typeof this.homey.app.energyManagerLabel === 'function' ? this.homey.app.energyManagerLabel() : '';
    const excerpt = manager
      ? this.homey.__('notifications.controlOverriddenBy', { name: this.getName(), manager })
      : this.homey.__('notifications.controlOverridden', { name: this.getName() });
    await this.homey.notifications.createNotification({ excerpt });
  }

  /** Reset the latched "Control overridden" alarm, see controlOverridden in the point map. */
  async clearControlOverridden() {
    if (!this.getStoreValue('controlOverridden')) return;
    await this.setStoreValue('controlOverridden', false);
    if (this.hasCapability('alarm_generic.control')) {
      await this.setCapabilityValue('alarm_generic.control', false).catch((error) => this.error(error));
    }
  }

  /** Refresh controls whose effect expires on the device unless it is written again. */
  async keepAlive() {
    if (!this.client) return;
    for (const control of this.controls) {
      // a queued write rewrites it anyway
      if (!control.keepAlive || this.controlBusy(control)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.queueControl(control, () => control.keepAlive({ client: this.client, device: this }))
        .catch((error) => this.error('keep-alive failed:', error.message));
    }
  }

  /**
   * Hand control back to the device itself, when the app stops or the device is deleted.
   * @param {object} [options] { deleted }: the device is deleted, not only stopped
   */
  async releaseControls({ deleted = false } = {}) {
    if (!this.client) return;
    for (const control of this.controls) {
      if (!control.release) continue;
      // eslint-disable-next-line no-await-in-loop
      await control.release({ client: this.client, device: this, deleted })
        .catch((error) => this.error('release failed:', error.message));
    }
  }

  /** Write again what the device lost, e.g. a limit an inverter restart reset (control `reapply`). */
  async reapplyControls(registers) {
    for (const control of this.controls) {
      if (!control.reapply || this.controlBusy(control)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.queueControl(control, () => control.reapply({ client: this.client, device: this, regs: registers }))
        .catch((error) => this.error('reapply failed:', error.message));
    }
  }

  // --- capabilities ----------------------------------------------------------------------

  /**
   * The capabilities this device should carry, in tile order: the point map's, minus what
   * `unsupported()` drops for this unit.
   */
  capabilityList() {
    return ModbusDevice.capabilityList(this.definition, this.detected);
  }

  /** capabilityList() for what detect() concluded, also at pairing. */
  static capabilityList(definition, detected) {
    const all = Object.keys(definition.capabilities);
    if (!definition.unsupported) return all;
    const drop = definition.unsupported(detected);
    return all.filter((capability) => !drop.includes(capability));
  }

  /** What detect() last concluded about this unit. `{}` means nothing is known yet. */
  get detected() {
    return this.getStoreValue('detected') || {};
  }

  /**
   * Work out what this unit can serve, once per (re)start: re-deciding per poll would only churn
   * capabilities on an odd read.
   */
  async runDetection() {
    if (this.detectionDone || !this.client) return;
    if (!this.definition.detect) {
      this.detectionDone = true;
      return;
    }

    const blocks = this.definition.detectBlocks(this.base).map((block) => ({ ...block, failures: 0 }));
    const refused = new Set();
    const registers = await this.readBlocks(blocks, { refused }).catch((error) => {
      this.error('detection read failed:', error.message);
      return new Map();
    });
    // unreachable: keep the stored verdict, retry after the first good poll
    if (registers.size === 0 && refused.size === 0) return;

    this.detectionDone = true;
    if (!this.identityRead) this.detectionRegisters = registers;
    // merged: a fact detect() could not read this time keeps its stored value
    const previous = this.detected;
    const detected = { ...previous, ...this.definition.detect(registers, previous, this.base, refused) };
    this.captureRegisters('Detection', registers, { previous, detected });
    await this.showDetectedSettings(detected);

    const keys = new Set([...Object.keys(detected), ...Object.keys(previous)]);
    // by value: a fact can be an array
    if (![...keys].some((key) => JSON.stringify(detected[key]) !== JSON.stringify(previous[key]))) return;

    this.log('device detection changed:', JSON.stringify(previous), '->', JSON.stringify(detected));
    await this.setStoreValue('detected', detected);
    this.buildBlocks();
    const migrated = await this.migrate();
    await this.applyCapabilityOptions({ force: migrated });
    // a capability detection added (target_power after the rated power) needs its listener and keep-alive
    await this.registerControls();
    if (this.pollInterval) this.startPolling();
  }

  /** Mirror what detect() found into the settings page (point map `detectedSettings`), when it differs. */
  async showDetectedSettings(detected) {
    if (!this.definition.detectedSettings) return;
    const known = new Set((this.driver.manifest.settings || [])
      .flatMap((setting) => [setting, ...(setting.children || [])])
      .map((setting) => setting.id));
    const changed = Object.fromEntries(Object.entries(this.definition.detectedSettings(detected, this))
      .filter(([key, value]) => known.has(key) && this.getSetting(key) !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch((error) => this.error(error));
  }

  /**
   * Ranges that depend on the unit, e.g. limits that run up to its rated power.
   * @param {object} [settings] { force }: write them unread, after a migration rebuilt capabilities
   */
  async applyCapabilityOptions({ force = false } = {}) {
    if (!this.definition.capabilityOptions) return;
    await DeviceMigrator.syncCapabilityOptions(this, this.definition.capabilityOptions(this.detected), { force });
  }

  /** The Homey Energy role of this unit (point map `energy`), e.g. only a grid meter is cumulative. */
  async applyEnergy() {
    if (!this.definition.energy) return;
    await DeviceMigrator.migrateEnergy(this, this.definition.energy(this))
      .catch((error) => this.error('could not set energy:', error.message));
  }

  /** Bring a paired device's capabilities, and their order, in line with capabilityList(). */
  async migrate() {
    return DeviceMigrator.migrateCapabilities(this, this.capabilityList());
  }

  /**
   * `undefined`: not read (failed block, absent register) - the tile keeps its value.
   * `null`: read, but no value right now (e.g. efficiency at night) - the tile is cleared.
   */
  async setCapability(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (value === undefined) {
      this.logUnmapped(capability);
      return;
    }
    if (typeof value === 'number' && Number.isNaN(value)) return;

    await this.setCapabilityValue(capability, value)
      .catch((error) => this.error(error, capability, value));
  }

  // No trigger() for '<capability>_changed' cards: Homey runs them itself, also for
  // sub-capabilities (confirmed live in com.foxess 2026-10-04; a trigger() made flows run twice).

  /** Log once per start that a capability's registers never arrived. */
  logUnmapped(capability) {
    if (this.unmappedLogged.has(capability)) return;
    this.unmappedLogged.add(capability);
    this.log(`no value for '${capability}' - its registers were not returned by this device`);
  }

  // --- lifecycle -------------------------------------------------------------------------

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    // settings stored in the device itself (point map `settingWrites`); a throw keeps the old values,
    // so the ones already written go back too
    const writes = this.definition.settingWrites || {};
    const toWrite = changedKeys.filter((key) => writes[key]);
    const written = [];
    for (const key of toWrite) {
      if (!this.client) throw Error(this.homey.__('errors.hostMissing'));
      try {
        // eslint-disable-next-line no-await-in-loop
        await writes[key]({ client: this.client, device: this, value: newSettings[key] });
        written.push(key);
      } catch (error) {
        this.error(`setting ${key} failed:`, error.message);
        for (const done of written.reverse()) {
          // eslint-disable-next-line no-await-in-loop
          await writes[done]({ client: this.client, device: this, value: oldSettings[done] })
            .catch((undoError) => this.error(`setting ${done} not restored:`, undoError.message));
        }
        if (error.refusal) throw error; // e.g. "unplug first"
        throw Error(`${this.homey.__('errors.modbusWriteFailed')} ${error.message}`);
      }
    }
    if (toWrite.length > 0) {
      // detect() can depend on it, e.g. the charger's minimum power
      this.detectionDone = false;
      this.homey.setTimeout(() => {
        this.runDetection().catch((error) => this.error(error));
      }, 1000);
    }

    if (changedKeys.some((key) => ['host', 'port', 'unitId'].includes(key))) {
      // getSettings() still returns the old values inside this handler
      this.homey.setTimeout(() => {
        this.connect()
          .then(() => this.startPolling())
          .catch((error) => this.error(error));
      }, 1000);
    } else if (changedKeys.includes('pollInterval')) {
      this.homey.setTimeout(() => this.startPolling(), 1000);
    }
  }

  onDeleted() {
    this.stopPolling();
    this.releaseControls({ deleted: true })
      .catch((error) => this.error(error))
      .finally(() => this.release());
    this.log('device was deleted', this.getName());
  }

  async onUninit() {
    this.stopPolling();
    await saveCounters(this);
    await this.releaseControls();
    this.release();
  }

};
