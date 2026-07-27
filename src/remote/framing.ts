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

import { decodeOscPacket, encodeOsc, type OscMessage } from './osc.js';

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

/**
 * Stateful framer that consumes incremental TCP chunks and yields complete
 * OSC messages. Frames are sentinel-delimited: each frame is one OSC packet
 * (a plain message or a `#bundle`) followed by the 16-byte FRAME_SENTINEL.
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

    // Frames are delimited by the 16-byte sentinel (Serato uses
    // CocoaAsyncSocket's `readDataToData:`). The packet before each sentinel
    // is one OSC packet — a plain message OR an OSC bundle (`#bundle`), which
    // Serato uses for `/Status/...` updates. Bundle length is not
    // self-describing at the top level, so we split on the sentinel and let
    // {@link decodeOscPacket} flatten bundles into their contained messages.
    while (this.buffer.length > 0) {
      const sentinelStart = this.buffer.indexOf(FRAME_SENTINEL);
      if (sentinelStart === -1) {
        // No complete frame yet. Guard against unbounded buffering.
        if (this.buffer.length > this.maxFrameBytes) {
          throw new Error(`OSC frame exceeds max ${this.maxFrameBytes} bytes without a sentinel`);
        }
        break;
      }
      if (sentinelStart > this.maxFrameBytes) {
        throw new Error(`OSC packet length ${sentinelStart} exceeds max ${this.maxFrameBytes}`);
      }

      const payload = this.buffer.subarray(0, sentinelStart);
      if (payload.length > 0) {
        messages.push(...decodeOscPacket(payload));
      }
      this.buffer = this.buffer.subarray(sentinelStart + FRAME_SENTINEL.length);
    }

    return messages;
  }

  /** Number of bytes currently buffered (incomplete frame). */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}
