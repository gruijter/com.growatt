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
 * Shared Modbus TCP helper. One file, kept identical (apart from the licence header) in
 * com.solarwatt, com.solaredge, com.foxess, com.growatt and com.sungrowpower so they cannot drift apart: change it
 * in every app at once.
 */

const ModbusException = require('./ModbusException');

/**
 * Decoders for the `Map<address, word>` a device reads its blocks into. They return `undefined`
 * for a register that was not read, which leaves its capability untouched.
 *
 * u32/i32/str: big-endian, high word first (SunSpec block 40000+; the SOLARWATT vision, measured:
 * 39149 reads 2513.5 kWh this way, 35875717 kWh with the words swapped). u32le/u64le/f32le: low
 * word first, as solaredge-modbus-multi and solaredged read SolarEdge's own blocks (0xE000+);
 * checked on the register dumps in python-solaredged's tests/fixtures. Sungrow's U32/S32 are low
 * word first too (hybrid protocol V1.1.17 §1.1).
 */

/** Unsigned 16-bit. */
const u16 = (regs, address) => regs.get(address);

/** Signed 16-bit. */
const i16 = (regs, address) => {
  const value = regs.get(address);
  if (value === undefined) return undefined;
  return value > 0x7fff ? value - 0x10000 : value;
};

/** Unsigned 32-bit, high word first. */
const u32 = (regs, address) => {
  const high = regs.get(address);
  const low = regs.get(address + 1);
  if (high === undefined || low === undefined) return undefined;
  return (high * 0x10000) + low;
};

/** Signed 32-bit, high word first. */
const i32 = (regs, address) => {
  const value = u32(regs, address);
  if (value === undefined) return undefined;
  return value > 0x7fffffff ? value - 0x100000000 : value;
};

/** Unsigned 32-bit, low word first. */
const u32le = (regs, address) => {
  const low = regs.get(address);
  const high = regs.get(address + 1);
  if (high === undefined || low === undefined) return undefined;
  return (high * 0x10000) + low;
};

/** Signed 32-bit, low word first. */
const i32le = (regs, address) => {
  const value = u32le(regs, address);
  if (value === undefined) return undefined;
  return value > 0x7fffffff ? value - 0x100000000 : value;
};

/** Unsigned 64-bit, low word first; a Number, exact up to 2^53. */
const u64le = (regs, address) => {
  let value = 0;
  for (let i = 3; i >= 0; i -= 1) {
    const word = regs.get(address + i);
    if (word === undefined) return undefined;
    value = (value * 0x10000) + word;
  }
  return value;
};

/** IEEE 754 float32, low word first. */
const f32le = (regs, address) => {
  const value = u32le(regs, address);
  if (value === undefined) return undefined;
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes.readFloatBE(0);
};

/**
 * ASCII string spread over `length` registers, two characters per register, high byte first.
 * Trailing NUL padding is stripped.
 */
const str = (regs, address, length) => {
  const bytes = Buffer.alloc(length * 2);
  let seen = 0;
  for (let i = 0; i < length; i += 1) {
    const word = regs.get(address + i);
    if (word === undefined) break;
    bytes.writeUInt16BE(word, i * 2);
    seen += 1;
  }
  if (seen === 0) return undefined;
  // NUL padding, stripped without a regex (no-control-regex)
  const text = bytes.subarray(0, seen * 2)
    .filter((byte) => byte !== 0)
    .toString('latin1')
    .trim();
  return text.length ? text : undefined;
};

/** Apply a documented gain, i.e. the raw value is `gain` times the real-world unit. */
const scale = (value, gain) => (value === undefined ? undefined : value / gain);

/** Round to `decimals`, so a 0.1-gain register doesn't surface 22.900000000000002. */
const round = (value, decimals = 2) => {
  if (value === undefined) return undefined;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** True when `index` is set in the bitfield register at `address`. */
const bit = (regs, address, index) => {
  const value = regs.get(address);
  if (value === undefined) return undefined;
  return ((value >> index) & 1) === 1;
};

/** Put a block as read (big-endian words from `start` on) into `regs`. */
const addWords = (regs, start, data) => {
  for (let i = 0; i < data.length / 2; i += 1) regs.set(start + i, data.readUInt16BE(i * 2));
  return regs;
};

/**
 * Map key of input register `address` (function code 0x04, block `input: true`): input and holding
 * registers can share an address (Growatt), so input registers sit above the 16-bit range.
 */
const INPUT = 0x10000;

/** The map key of a block's first register. */
const blockKey = (block) => (block.input ? INPUT : 0) + block.start;

/** Exception codes that mean the server refused the read, as opposed to a timeout or a lost connection. */
const REFUSED_CODES = [1, 2, 3];

/**
 * Part sizes a `split` block is read in, each aligned to its own multiples. 45 is the longest read of
 * Growatt's legacy PV protocol (V3.14: "registers should be in the range of times of 45, eg 1~45 or
 * 96~123 are OK, but 40~60 is not OK"); a part the server still refuses is read in smaller ones.
 */
const PART_SIZES = [45, 8, 1];

const isRefusal = (error) => error instanceof ModbusException && REFUSED_CODES.includes(error.code);

/** Read `count` registers at `start` of `block` (same function code) into `regs`. */
const readAt = async (regs, client, block, start, count) => addWords(
  regs,
  blockKey({ input: block.input, start }),
  await client.readRegisters(start, count, block.input ? 0x04 : 0x03),
);

/**
 * Read registers `start` up to `end` of a `split` block in parts of PART_SIZES[level]. A refused part is
 * read in the next smaller size. When the first part gives nothing the rest is not there either, so
 * an absent range costs a few requests, not one per register. Returns how many registers were read.
 */
const readParts = async (regs, client, block, start, end, level) => {
  const size = PART_SIZES[level];
  let read = 0;
  for (let from = start; from < end;) {
    const to = Math.min(end, (Math.floor(from / size) + 1) * size);
    let got = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      await readAt(regs, client, block, from, to - from);
      got = to - from;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      // eslint-disable-next-line no-await-in-loop
      if (level < PART_SIZES.length - 1) got = await readParts(regs, client, block, from, to, level + 1);
    }
    read += got;
    if (read === 0) return 0;
    from = to;
  }
  return read;
};

/**
 * Read `block` over `client` into `regs`: holding registers (0x03), or input registers (0x04) at INPUT + address.
 * A block with `split` that the server refuses as a whole is read in parts instead (readParts); when
 * not one register of it can be read, the refusal of the whole read is thrown.
 */
const readBlock = async (regs, client, block) => {
  if (!block.split) return readAt(regs, client, block, block.start, block.count);
  try {
    return await readAt(regs, client, block, block.start, block.count);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    if (await readParts(regs, client, block, block.start, block.start + block.count, 0) === 0) throw error;
    return regs;
  }
};

/** Copy `block` from `from` into `regs` when `from` holds all of its registers; false when not. */
const copyBlock = (from, regs, block) => {
  if (!from) return false;
  const first = blockKey(block);
  for (let address = first; address < first + block.count; address += 1) if (!from.has(address)) return false;
  for (let address = first; address < first + block.count; address += 1) regs.set(address, from.get(address));
  return true;
};

module.exports = {
  u16, i16, u32, i32, u32le, i32le, u64le, f32le, str, scale, round, bit, addWords, INPUT, blockKey, readBlock, copyBlock,
};
