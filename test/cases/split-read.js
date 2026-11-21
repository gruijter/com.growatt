'use strict';

/* A server that refuses some reads as a whole (exception 1) gets its block read in parts when the block
   is `split`: a whole block it refuses is not missing as a whole, only the refused parts. Without `split`
   the refusal is thrown as before, and a timeout or a lost connection is always thrown. */

const ModbusException = require('../../lib/ModbusException');
const { readBlock } = require('../../lib/registers');
const growatt = require('../../lib/growattModbusPointMap');

// the value of register `address` in this fake server
const valueAt = (address) => (address * 7 + 3) & 0xffff;

// a read is refused when it is longer than one register and includes address 44 (a real device refused such reads)
const refuses = (address, count) => count > 1 && address <= 44 && address + count - 1 >= 44;

const fakeClient = ({ refused = refuses, failAt = null } = {}) => {
  const reads = [];
  return {
    reads,
    readRegisters: async (start, count, fc) => {
      reads.push(`${fc}:${start}+${count}`);
      if (failAt !== null && start <= failAt && failAt < start + count) throw Object.assign(Error('Timeout'), { timedOut: true });
      if (refused(start, count)) throw new ModbusException(1);
      const data = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i += 1) data.writeUInt16BE(valueAt(start + i), i * 2);
      return data;
    },
  };
};

module.exports = async (t) => {
  const block = { start: 0, count: 125 };

  // a split block the server refuses as a whole is read in parts: every register but the refused one
  // comes out, and the refused parts are read one register at a time
  {
    const regs = new Map();
    const client = fakeClient();
    await readBlock(regs, client, { ...block, split: true });
    t.eq(regs.size, 125, 'split: every register of the block is read in parts');
    t.eq(regs.get(44), valueAt(44), 'split: the register inside a refused part is read on its own');
    t.eq(regs.get(124), valueAt(124), 'split: the last register is read');
    t.ok(client.reads.includes('3:0+125'), 'split: the whole block is tried first');
    t.ok(client.reads.includes('3:45+45') && client.reads.includes('3:90+35'), 'split: then in parts of 45 registers, aligned to multiples of 45');
    t.ok(client.reads.includes('3:8+8') && client.reads.includes('3:40+5'), 'split: a refused part of 45 in parts of 8');
    t.ok(client.reads.includes('3:44+1'), 'split: a refused part of 8 one register at a time');
  }

  // a server that answers inside windows of 45 registers only (Growatt's legacy protocol): three requests
  {
    const regs = new Map();
    const client = fakeClient({ refused: (start, count) => Math.floor(start / 45) !== Math.floor((start + count - 1) / 45) });
    await readBlock(regs, client, { ...block, split: true });
    t.eq(client.reads.join(' '), '3:0+125 3:0+45 3:45+45 3:90+35', 'windows of 45: the whole read is refused, then three windows answer');
    t.eq(regs.size, 125, 'windows of 45: every register is read');
    const poll = fakeClient({ refused: (start, count) => Math.floor(start / 45) !== Math.floor((start + count - 1) / 45) });
    await readBlock(new Map(), poll, {
      start: 45, count: 20, input: true, split: true,
    });
    t.eq(poll.reads.join(' '), '4:45+20', 'windows of 45: a read inside one window is not split');
  }

  // a block that is not there at all costs a few requests, not one per register
  {
    const client = fakeClient({ refused: () => true });
    let thrown = null;
    try {
      await readBlock(new Map(), client, {
        start: 3000, count: 125, input: true, split: true,
      });
    } catch (error) {
      thrown = error;
    }
    t.ok(thrown instanceof ModbusException, 'absent block: the refusal is thrown');
    t.ok(client.reads.length <= 4, `absent block: at most 4 requests (${client.reads.length})`);
  }

  // without `split` the refusal is thrown, as before
  {
    const regs = new Map();
    let thrown = null;
    try {
      await readBlock(regs, fakeClient(), { ...block });
    } catch (error) {
      thrown = error;
    }
    t.ok(thrown instanceof ModbusException && thrown.code === 1, 'no split: a refused block throws the exception');
    t.eq(regs.size, 0, 'no split: nothing is read');
  }

  // a block whose first part is refused is not there: its refusal is thrown, not an empty result
  {
    const regs = new Map();
    let thrown = null;
    try {
      await readBlock(regs, fakeClient({ refused: (start) => start >= 0 }), {
        start: 3000, count: 125, input: true, split: true,
      });
    } catch (error) {
      thrown = error;
    }
    t.ok(thrown instanceof ModbusException && thrown.code === 1, 'split: a block refused from its first part throws the refusal');
    t.eq(regs.size, 0, 'split: nothing is kept from a refused block');
  }

  // a timeout inside the parts is not a refusal: it is thrown
  {
    const regs = new Map();
    let thrown = null;
    try {
      await readBlock(regs, fakeClient({ failAt: 60 }), { start: 0, count: 125, split: true });
    } catch (error) {
      thrown = error;
    }
    t.ok(thrown && thrown.timedOut, 'split: a timeout in a part is thrown');
  }

  // the Growatt identity block is read in parts from a device refusing its whole read: the serial number
  // and the rated power decode as they do from a server that answers the whole read
  {
    const regs = new Map();
    // the server refuses reads longer than a part from 0, so block 0 comes in parts
    const client = fakeClient({ refused: (start, count) => count > 8 && start === 0 });
    for (const b of growatt.inverter.identityBlocks()) {
      try {
        await readBlock(regs, client, b);
      } catch (error) {
        if (!b.optional) throw error;
      }
    }
    t.ok(regs.size >= 125, 'identity: the 125 registers of block 0 are read in parts');
    t.ok([23, 24, 25, 26, 27, 43, 44, 124].every((address) => regs.get(address) === valueAt(address)), 'identity: the registers of the serial number, device type and rated power are there');
    t.ok(growatt.inverter.pairable(regs) === true, 'identity: the inverter is pairable from the parts');
  }
};
