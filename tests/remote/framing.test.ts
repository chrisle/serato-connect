import { describe, it, expect } from 'vitest';
import { FRAME_SENTINEL, FrameReader, frameOsc } from '../../src/remote/framing.js';
import { encodeOsc, osc, arg } from '../../src/remote/osc.js';

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

  it('appends the 16-byte sentinel after each encoded packet', () => {
    const frame = frameOsc(osc('/Ping'));
    const oscBytes = encodeOsc(osc('/Ping'));
    expect(frame.length).toBe(oscBytes.length + FRAME_SENTINEL.length);
    expect(frame.subarray(oscBytes.length)).toEqual(FRAME_SENTINEL);
  });

  it('throws if the sentinel is missing where expected', () => {
    const reader = new FrameReader();
    const oscBytes = encodeOsc(osc('/Ping'));
    const wrongTrailer = Buffer.alloc(FRAME_SENTINEL.length); // all zeros
    const bad = Buffer.concat([oscBytes, wrongTrailer]);
    expect(() => reader.push(bad)).toThrow(/sentinel mismatch/);
  });

  it('parses a captured Serato Authorize/Request blob frame', () => {
    // Captured 2026-05-05: ,bii with 16-byte blob and two int32=1
    const reader = new FrameReader();
    const frame = frameOsc(
      osc(
        '/StreamMgmt/Authorize/Request',
        arg.b(Buffer.from('3f47500e7d40141e774a9b908ef6bec0', 'hex')),
        arg.i(1),
        arg.i(1),
      ),
    );
    const out = reader.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0].address).toBe('/StreamMgmt/Authorize/Request');
    expect(out[0].args).toHaveLength(3);
    expect(out[0].args[0].type).toBe('b');
    expect((out[0].args[0] as { type: 'b'; value: Buffer }).value.length).toBe(16);
  });
});
