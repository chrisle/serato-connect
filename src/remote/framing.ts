/**
 * @fileoverview TCP framing for the Serato Remote OSC protocol.
 *
 * Verified by live capture against Serato DJ Pro 3.3.5.29 (2026-05-05):
 *
 *   <bare OSC packet (no length prefix)> <16-byte SENTINEL>
 *
 * The sentinel is a constant 16-byte value that marks the end of every
 * frame. It is hardcoded in the Serato binary near the
 * `serato::connection::USBMuxDNetworkStream` C++ class typeinfo and is
 * (probably) used by `readDataToData:`-style framing in CocoaAsyncSocket.
 *
 * TCP can split or coalesce these writes arbitrarily, so the framer must
 * tolerate the 12-byte and 16-byte halves arriving in any combination of
 * chunks. We parse OSC packets by their self-describing length (address +
 * type-tag + typed args), then consume the sentinel.
 */

import { decodeOsc, encodeOsc, type OscMessage } from './osc.js';

/**
 * 16-byte sentinel that follows every OSC packet on the Serato Remote wire.
 * Captured from Serato DJ Pro 3.3.5.29 — see protocol.md for context.
 */
export const FRAME_SENTINEL: Buffer = Buffer.from([
  0x4c, 0xaa, 0xc2, 0xae, 0x35, 0xb1, 0xc4, 0x76, 0xdb, 0x5a, 0x64, 0x44, 0x03, 0xbd, 0x41, 0x70,
]);

/** Wrap an OSC message: bare encoded bytes followed by the 16-byte sentinel. */
export function frameOsc(msg: OscMessage): Buffer {
  return Buffer.concat([encodeOsc(msg), FRAME_SENTINEL]);
}

/** Round `n` up to the next multiple of 4. */
function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Locate the next null byte at offset `start` and return the index just
 * after the padded string (4-byte alignment, including the null).
 */
function nextOscStringEnd(buf: Buffer, start: number): number | null {
  let i = start;
  while (i < buf.length && buf[i] !== 0) i++;
  if (i >= buf.length) return null;
  const consumed = i - start + 1;
  return start + pad4(consumed);
}

/**
 * Compute the total byte length of one bare OSC packet starting at offset
 * `start`. Returns null if the buffer is too short to fully describe a
 * packet (caller should wait for more bytes). Throws on a malformed type-tag
 * or unknown arg type.
 */
function oscPacketLength(buf: Buffer, start: number): number | null {
  if (start >= buf.length) return null;
  const afterAddr = nextOscStringEnd(buf, start);
  if (afterAddr === null) return null;
  const afterTag = nextOscStringEnd(buf, afterAddr);
  if (afterTag === null) return null;

  // The type-tag string starts with ',' and lists each arg's type code.
  let tagEnd = afterAddr;
  while (tagEnd < buf.length && buf[tagEnd] !== 0) tagEnd++;
  const tagString = buf.toString('utf8', afterAddr, tagEnd);
  if (!tagString.startsWith(',')) {
    throw new Error(`OSC type-tag missing leading comma: "${tagString}"`);
  }

  let cursor = afterTag;
  for (const tag of tagString.slice(1)) {
    switch (tag) {
      case 'i':
      case 'f':
        cursor += 4;
        break;
      case 'h':
      case 'd':
      case 't':
        cursor += 8;
        break;
      case 's':
      case 'S': {
        const next = nextOscStringEnd(buf, cursor);
        if (next === null) return null;
        cursor = next;
        break;
      }
      case 'b': {
        if (cursor + 4 > buf.length) return null;
        const blobLen = buf.readUInt32BE(cursor);
        cursor += 4 + pad4(blobLen);
        break;
      }
      case 'T':
      case 'F':
      case 'N':
      case 'I':
        // typed but zero-byte
        break;
      default:
        throw new Error(`Unsupported OSC type tag '${tag}' in framing scan`);
    }
    if (cursor > buf.length) return null;
  }
  return cursor - start;
}

/**
 * Stateful framer that consumes incremental TCP chunks and yields complete
 * OSC messages. Uses bare-OSC framing: each frame is one OSC packet
 * followed by the 16-byte FRAME_SENTINEL.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Maximum allowed bare-OSC packet length; guards against runaway allocations. */
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = 1 << 20) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): OscMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: OscMessage[] = [];

    while (this.buffer.length > 0) {
      const oscLen = oscPacketLength(this.buffer, 0);
      if (oscLen === null) break;
      if (oscLen > this.maxFrameBytes) {
        throw new Error(`OSC packet length ${oscLen} exceeds max ${this.maxFrameBytes}`);
      }
      const totalNeeded = oscLen + FRAME_SENTINEL.length;
      if (this.buffer.length < totalNeeded) break;

      // Verify the sentinel is where we expect.
      const sentinelStart = oscLen;
      let sentinelOk = true;
      for (let i = 0; i < FRAME_SENTINEL.length; i++) {
        if (this.buffer[sentinelStart + i] !== FRAME_SENTINEL[i]) {
          sentinelOk = false;
          break;
        }
      }
      if (!sentinelOk) {
        throw new Error('OSC frame sentinel mismatch — protocol drift detected');
      }

      const payload = this.buffer.subarray(0, oscLen);
      messages.push(decodeOsc(payload));
      this.buffer = this.buffer.subarray(totalNeeded);
    }

    return messages;
  }

  /** Number of bytes currently buffered (incomplete frame). */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}
