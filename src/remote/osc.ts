/**
 * @fileoverview OSC 1.1 message encoding/decoding for the Serato Remote protocol.
 *
 * Implements the subset of OSC types used by the protocol:
 *   - i: int32 (big-endian)
 *   - f: float32 (big-endian, IEEE 754)
 *   - s: null-terminated string, padded to 4-byte boundary
 *
 * Each message is: <address-pattern> <type-tag-string> <args...>, with each
 * field aligned to a 4-byte boundary.
 */

export type OscArg =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 's'; value: string }
  | { type: 'b'; value: Buffer };

export interface OscMessage {
  address: string;
  args: OscArg[];
}

/** Round `n` up to the next multiple of 4. */
function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Encode an OSC string: UTF-8 bytes, null terminator, then zero-pad to a
 * 4-byte boundary. The null terminator counts toward the padded length.
 */
function encodeOscString(s: string): Buffer {
  const utf8Len = Buffer.byteLength(s, 'utf8');
  const totalLen = pad4(utf8Len + 1);
  const buf = Buffer.alloc(totalLen);
  buf.write(s, 0, 'utf8');
  return buf;
}

/**
 * Decode an OSC string starting at `offset`. Returns the decoded string and
 * the offset of the first byte after the padded string.
 */
function decodeOscString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) {
    end++;
  }
  if (end >= buf.length) {
    throw new Error('OSC string not null-terminated');
  }
  const value = buf.toString('utf8', offset, end);
  const consumed = end - offset + 1;
  return { value, next: offset + pad4(consumed) };
}

/** Encode a single OSC message into a Buffer. Throws on unsupported arg types. */
export function encodeOsc(msg: OscMessage): Buffer {
  const addrBuf = encodeOscString(msg.address);
  const tagString = ',' + msg.args.map((a) => a.type).join('');
  const tagBuf = encodeOscString(tagString);

  const argBufs: Buffer[] = [];
  for (const arg of msg.args) {
    switch (arg.type) {
      case 'i': {
        const b = Buffer.alloc(4);
        b.writeInt32BE(arg.value | 0, 0);
        argBufs.push(b);
        break;
      }
      case 'f': {
        const b = Buffer.alloc(4);
        b.writeFloatBE(arg.value, 0);
        argBufs.push(b);
        break;
      }
      case 's': {
        argBufs.push(encodeOscString(arg.value));
        break;
      }
      case 'b': {
        const len = arg.value.length;
        const padded = pad4(len);
        const b = Buffer.alloc(4 + padded);
        b.writeUInt32BE(len, 0);
        arg.value.copy(b, 4);
        argBufs.push(b);
        break;
      }
    }
  }

  return Buffer.concat([addrBuf, tagBuf, ...argBufs]);
}

/** Decode a single OSC message from a Buffer. Throws on malformed input. */
export function decodeOsc(buf: Buffer): OscMessage {
  const { value: address, next: afterAddr } = decodeOscString(buf, 0);

  // OSC 1.0 permits omitting the type-tag string entirely, meaning zero
  // arguments. Serato DJ Pro sends such argless messages during pairing
  // (e.g. its Pairing acknowledgements), so treat a missing or empty tag
  // section as "no args" rather than rejecting the frame. Only a present
  // tag string that fails to start with ',' is malformed.
  if (afterAddr >= buf.length) {
    return { address, args: [] };
  }
  const { value: tagString, next: afterTags } = decodeOscString(buf, afterAddr);
  if (tagString === '') {
    return { address, args: [] };
  }
  if (!tagString.startsWith(',')) {
    throw new Error(`OSC type-tag string missing leading comma: "${tagString}"`);
  }

  const tags = tagString.slice(1);
  const args: OscArg[] = [];
  let cursor = afterTags;

  for (const tag of tags) {
    switch (tag) {
      case 'i': {
        if (cursor + 4 > buf.length) throw new Error('OSC int32 truncated');
        args.push({ type: 'i', value: buf.readInt32BE(cursor) });
        cursor += 4;
        break;
      }
      case 'f': {
        if (cursor + 4 > buf.length) throw new Error('OSC float32 truncated');
        args.push({ type: 'f', value: buf.readFloatBE(cursor) });
        cursor += 4;
        break;
      }
      case 's': {
        const { value, next } = decodeOscString(buf, cursor);
        args.push({ type: 's', value });
        cursor = next;
        break;
      }
      case 'b': {
        if (cursor + 4 > buf.length) throw new Error('OSC blob length truncated');
        const blobLen = buf.readUInt32BE(cursor);
        cursor += 4;
        if (cursor + blobLen > buf.length) throw new Error('OSC blob data truncated');
        const value = Buffer.from(buf.subarray(cursor, cursor + blobLen));
        args.push({ type: 'b', value });
        cursor += pad4(blobLen);
        break;
      }
      default:
        throw new Error(`Unsupported OSC type tag '${tag}'`);
    }
  }

  return { address, args };
}

/** The OSC bundle marker: the ASCII string `#bundle` followed by a null. */
const BUNDLE_MARKER = '#bundle';

/**
 * Decode a single OSC packet, which is either a plain message or a bundle.
 *
 * Serato DJ Pro delivers its `/Status/...` updates as OSC bundles
 * (`#bundle` + 8-byte time-tag + a sequence of 4-byte-size-prefixed
 * elements, each itself a packet). This flattens a bundle — including
 * nested bundles — into the list of contained messages, in order. A plain
 * message decodes to a single-element array.
 */
export function decodeOscPacket(buf: Buffer): OscMessage[] {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === BUNDLE_MARKER) {
    const messages: OscMessage[] = [];
    // Skip "#bundle\0" (8 bytes) + the OSC time-tag (8 bytes).
    let cursor = 16;
    while (cursor + 4 <= buf.length) {
      const size = buf.readUInt32BE(cursor);
      cursor += 4;
      if (size === 0) continue;
      if (cursor + size > buf.length) {
        throw new Error('OSC bundle element size exceeds packet');
      }
      messages.push(...decodeOscPacket(buf.subarray(cursor, cursor + size)));
      cursor += size;
    }
    return messages;
  }
  return [decodeOsc(buf)];
}

/** Build an OSC message with the given address and typed args. */
export function osc(address: string, ...args: OscArg[]): OscMessage {
  return { address, args };
}

export const arg = {
  i: (value: number): OscArg => ({ type: 'i', value }),
  f: (value: number): OscArg => ({ type: 'f', value }),
  s: (value: string): OscArg => ({ type: 's', value }),
  b: (value: Buffer): OscArg => ({ type: 'b', value }),
};
