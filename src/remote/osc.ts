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
  | { type: 's'; value: string };

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
    }
  }

  return Buffer.concat([addrBuf, tagBuf, ...argBufs]);
}

/** Decode a single OSC message from a Buffer. Throws on malformed input. */
export function decodeOsc(buf: Buffer): OscMessage {
  const { value: address, next: afterAddr } = decodeOscString(buf, 0);
  const { value: tagString, next: afterTags } = decodeOscString(buf, afterAddr);

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
      default:
        throw new Error(`Unsupported OSC type tag '${tag}'`);
    }
  }

  return { address, args };
}

/** Build an OSC message with the given address and typed args. */
export function osc(address: string, ...args: OscArg[]): OscMessage {
  return { address, args };
}

export const arg = {
  i: (value: number): OscArg => ({ type: 'i', value }),
  f: (value: number): OscArg => ({ type: 'f', value }),
  s: (value: string): OscArg => ({ type: 's', value }),
};
