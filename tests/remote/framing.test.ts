import { describe, it, expect } from 'vitest';
import { FrameReader, frameOsc } from '../../src/remote/framing.js';
import { osc, arg } from '../../src/remote/osc.js';

describe('FrameReader', () => {
  it('returns one message for one whole frame', () => {
    const reader = new FrameReader();
    const frame = frameOsc(osc('/Ping'));
    const out = reader.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe('/Ping');
    expect(reader.pendingBytes).toBe(0);
  });

  it('reassembles a frame split across multiple chunks', () => {
    const reader = new FrameReader();
    const frame = frameOsc(osc('/Status/Deck/Song/Title', arg.i(0), arg.s('Hello')));
    // Split into 1-byte chunks to stress incremental reading.
    let messages: ReturnType<FrameReader['push']> = [];
    for (let i = 0; i < frame.length; i++) {
      messages = messages.concat(reader.push(frame.subarray(i, i + 1)));
    }
    expect(messages).toHaveLength(1);
    expect(messages[0].address).toBe('/Status/Deck/Song/Title');
    expect(reader.pendingBytes).toBe(0);
  });

  it('yields multiple messages when several frames arrive in one chunk', () => {
    const reader = new FrameReader();
    const a = frameOsc(osc('/Ping'));
    const b = frameOsc(osc('/Status/Video/Mixer/Crossfader', arg.f(0.5)));
    const c = frameOsc(osc('/Status/Deck/Song/Valid', arg.i(1), arg.f(1)));
    const out = reader.push(Buffer.concat([a, b, c]));
    expect(out.map((m) => m.address)).toEqual([
      '/Ping',
      '/Status/Video/Mixer/Crossfader',
      '/Status/Deck/Song/Valid',
    ]);
  });

  it('keeps a partial frame buffered for the next push', () => {
    const reader = new FrameReader();
    const a = frameOsc(osc('/Ping'));
    const b = frameOsc(osc('/Status/Deck/Song/Title', arg.i(2), arg.s('next')));
    const combined = Buffer.concat([a, b]);
    const split = a.length + 4; // mid-way through the second frame's payload
    const first = reader.push(combined.subarray(0, split));
    expect(first).toHaveLength(1);
    expect(first[0].address).toBe('/Ping');
    expect(reader.pendingBytes).toBeGreaterThan(0);
    const second = reader.push(combined.subarray(split));
    expect(second).toHaveLength(1);
    expect(second[0].address).toBe('/Status/Deck/Song/Title');
  });

  it('rejects an oversized length prefix', () => {
    const reader = new FrameReader(64); // 64-byte cap
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(1024, 0);
    expect(() => reader.push(oversized)).toThrow(/exceeds max/);
  });
});
