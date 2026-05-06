/**
 * @fileoverview TCP framing for OSC packets.
 *
 * Each OSC packet on the TCP stream is preceded by a 4-byte big-endian
 * length prefix giving the byte-length of the OSC payload that follows.
 * This matches `oscpack`'s default framing — Serato DJ Pro is built on
 * oscpack, so this is the assumed wire format pending live capture
 * confirmation.
 */

import { decodeOsc, encodeOsc, type OscMessage } from './osc.js';

/** Wrap an OSC message in the 4-byte big-endian length-prefix frame. */
export function frameOsc(msg: OscMessage): Buffer {
  const payload = encodeOsc(msg);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

/**
 * Stateful framer that consumes incremental TCP chunks and yields complete
 * OSC messages. Use one instance per TCP connection.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Maximum allowed frame length; guards against runaway allocations. */
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = 1 << 20) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /** Append a TCP chunk and yield every complete OSC message it now contains. */
  push(chunk: Buffer): OscMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: OscMessage[] = [];

    while (this.buffer.length >= 4) {
      const frameLen = this.buffer.readUInt32BE(0);
      if (frameLen > this.maxFrameBytes) {
        throw new Error(`OSC frame length ${frameLen} exceeds max ${this.maxFrameBytes}`);
      }
      if (this.buffer.length < 4 + frameLen) {
        break;
      }
      const payload = this.buffer.subarray(4, 4 + frameLen);
      messages.push(decodeOsc(payload));
      this.buffer = this.buffer.subarray(4 + frameLen);
    }

    return messages;
  }

  /** Number of bytes currently buffered (incomplete frame). */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}
