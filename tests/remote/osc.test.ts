import { describe, it, expect } from 'vitest';
import { encodeOsc, decodeOsc, osc, arg } from '../../src/remote/osc.js';

describe('OSC encode/decode', () => {
  it('round-trips an empty message', () => {
    const msg = osc('/Ping');
    const buf = encodeOsc(msg);
    expect(buf.length % 4).toBe(0);
    const decoded = decodeOsc(buf);
    expect(decoded).toEqual({ address: '/Ping', args: [] });
  });

  it('round-trips an `is` message (Title)', () => {
    const msg = osc('/Status/Deck/Song/Title', arg.i(0), arg.s('Track Of The Night'));
    const buf = encodeOsc(msg);
    expect(buf.length % 4).toBe(0);
    const decoded = decodeOsc(buf);
    expect(decoded.address).toBe('/Status/Deck/Song/Title');
    expect(decoded.args).toEqual([
      { type: 'i', value: 0 },
      { type: 's', value: 'Track Of The Night' },
    ]);
  });

  it('round-trips an `if` message (AutoLoopOn)', () => {
    const msg = osc('/Status/Deck/Loop/AutoLoopOn', arg.i(2), arg.f(1.0));
    const decoded = decodeOsc(encodeOsc(msg));
    expect(decoded.address).toBe('/Status/Deck/Loop/AutoLoopOn');
    expect(decoded.args[0]).toEqual({ type: 'i', value: 2 });
    expect(decoded.args[1].type).toBe('f');
    expect((decoded.args[1] as { value: number }).value).toBeCloseTo(1.0, 5);
  });

  it('round-trips an `ifff` message (Playhead)', () => {
    const msg = osc(
      '/Status/Deck/Playhead',
      arg.i(1),
      arg.f(42.5),
      arg.f(180.25),
      arg.f(124.5)
    );
    const decoded = decodeOsc(encodeOsc(msg));
    expect(decoded.address).toBe('/Status/Deck/Playhead');
    expect(decoded.args[0]).toEqual({ type: 'i', value: 1 });
    const f = decoded.args.slice(1).map((a) => (a as { value: number }).value);
    expect(f[0]).toBeCloseTo(42.5, 5);
    expect(f[1]).toBeCloseTo(180.25, 5);
    expect(f[2]).toBeCloseTo(124.5, 5);
  });

  it('round-trips a single-`f` message (Crossfader)', () => {
    const msg = osc('/Status/Video/Mixer/Crossfader', arg.f(-0.25));
    const decoded = decodeOsc(encodeOsc(msg));
    expect(decoded.address).toBe('/Status/Video/Mixer/Crossfader');
    expect((decoded.args[0] as { value: number }).value).toBeCloseTo(-0.25, 5);
  });

  it('pads strings to 4-byte alignment with the null terminator counted', () => {
    // "abc" + null = 4 bytes — already aligned, no extra padding.
    const buf3 = encodeOsc(osc('abc'));
    // address (4 bytes) + ",\0\0\0" type tag (4 bytes) = 8.
    expect(buf3.length).toBe(8);

    // "abcd" + null = 5 bytes — pads to 8.
    const buf4 = encodeOsc(osc('abcd'));
    expect(buf4.length).toBe(8 + 4);
  });

  it('decodes UTF-8 strings correctly', () => {
    const title = 'Café — Étude n°3';
    const msg = osc('/Status/Deck/Song/Title', arg.i(0), arg.s(title));
    const decoded = decodeOsc(encodeOsc(msg));
    expect(decoded.args[1]).toEqual({ type: 's', value: title });
  });

  it('throws on a missing leading comma in the type-tag string', () => {
    // Hand-craft a buffer with the type-tag string missing the leading comma.
    const addr = Buffer.alloc(4);
    addr.write('/X');
    const tags = Buffer.alloc(4);
    tags.write('iX'); // no leading comma
    expect(() => decodeOsc(Buffer.concat([addr, tags]))).toThrow(/leading comma/);
  });

  it('throws on an unsupported type tag', () => {
    const buf = encodeOsc(osc('/X', arg.i(1)));
    // Patch the type tag to something unsupported.
    const tagOffset = 4; // address "/X\0\0" occupies 4 bytes
    buf[tagOffset + 1] = 'q'.charCodeAt(0);
    expect(() => decodeOsc(buf)).toThrow(/Unsupported OSC type tag/);
  });
});
