/**
 * Tests for Serato BeatGrid parser.
 */

import { describe, it, expect } from 'vitest';
import {
  parseBeatgrid,
  parseBeatgridFromBase64,
  getBpmFromBeatgrid,
  isDynamicBeatgrid,
} from '../../../src/parsers/geob/beatgrid.js';

describe('BeatGrid parser', () => {
  /**
   * Create a beatgrid buffer with the given markers.
   *
   * @param markers Array of { position, bpm? | beatsToNext? }
   */
  function createBeatgridBuffer(markers: Array<{ position: number; bpm?: number; beatsToNext?: number }>): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt32BE(markers.length, 2); // Marker count at offset 2

    const markerBuffers = markers.map((m, i) => {
      const buf = Buffer.alloc(8);
      buf.writeFloatBE(m.position, 0);
      if (i === markers.length - 1) {
        // Terminal marker: write BPM as float
        buf.writeFloatBE(m.bpm || 120, 4);
      } else {
        // Non-terminal: write beats to next as uint32
        buf.writeUInt32BE(m.beatsToNext || 0, 4);
      }
      return buf;
    });

    const footer = Buffer.from([0x00]);

    return Buffer.concat([header, ...markerBuffers, footer]);
  }

  describe('parseBeatgrid', () => {
    it('returns empty result for empty buffer', () => {
      const result = parseBeatgrid(Buffer.alloc(0));
      expect(result.markers).toEqual([]);
    });

    it('returns empty result for buffer smaller than header', () => {
      const result = parseBeatgrid(Buffer.alloc(5));
      expect(result.markers).toEqual([]);
    });

    it('returns empty result for zero marker count', () => {
      const buffer = Buffer.alloc(7); // header + footer
      buffer.writeUInt32BE(0, 2); // 0 markers
      const result = parseBeatgrid(buffer);
      expect(result.markers).toEqual([]);
    });

    it('parses single terminal marker', () => {
      const buffer = createBeatgridBuffer([
        { position: 0.5, bpm: 128.0 },
      ]);

      const result = parseBeatgrid(buffer);
      expect(result.markers.length).toBe(1);
      expect(result.markers[0].position).toBeCloseTo(0.5, 2);
      expect(result.markers[0].bpm).toBeCloseTo(128.0, 2);
      expect(result.markers[0].beatsToNext).toBeUndefined();
    });

    it('parses multiple markers with terminal', () => {
      const buffer = createBeatgridBuffer([
        { position: 0.0, beatsToNext: 16 },
        { position: 4.0, beatsToNext: 32 },
        { position: 12.0, bpm: 140.0 },
      ]);

      const result = parseBeatgrid(buffer);
      expect(result.markers.length).toBe(3);

      // Non-terminal markers
      expect(result.markers[0].position).toBeCloseTo(0.0, 2);
      expect(result.markers[0].beatsToNext).toBe(16);
      expect(result.markers[0].bpm).toBeUndefined();

      expect(result.markers[1].position).toBeCloseTo(4.0, 2);
      expect(result.markers[1].beatsToNext).toBe(32);

      // Terminal marker
      expect(result.markers[2].position).toBeCloseTo(12.0, 2);
      expect(result.markers[2].bpm).toBeCloseTo(140.0, 2);
      expect(result.markers[2].beatsToNext).toBeUndefined();
    });
  });

  describe('parseBeatgridFromBase64', () => {
    it('decodes and parses base64 data', () => {
      const buffer = createBeatgridBuffer([
        { position: 1.0, bpm: 120.0 },
      ]);

      const base64 = buffer.toString('base64');
      const result = parseBeatgridFromBase64(base64);

      expect(result.markers.length).toBe(1);
      expect(result.markers[0].bpm).toBeCloseTo(120.0, 2);
    });

    it('handles base64 with linebreaks', () => {
      const buffer = createBeatgridBuffer([
        { position: 0.0, bpm: 128.0 },
      ]);

      let base64 = buffer.toString('base64');
      base64 = base64.slice(0, 5) + '\n' + base64.slice(5);

      const result = parseBeatgridFromBase64(base64);
      expect(result.markers.length).toBe(1);
    });
  });

  describe('getBpmFromBeatgrid', () => {
    it('returns undefined for empty beatgrid', () => {
      const result = getBpmFromBeatgrid({ markers: [] });
      expect(result).toBeUndefined();
    });

    it('returns BPM from single marker', () => {
      const beatgrid = parseBeatgrid(createBeatgridBuffer([
        { position: 0.0, bpm: 128.0 },
      ]));

      const bpm = getBpmFromBeatgrid(beatgrid);
      expect(bpm).toBeCloseTo(128.0, 2);
    });

    it('returns BPM from terminal marker in multi-marker grid', () => {
      const beatgrid = parseBeatgrid(createBeatgridBuffer([
        { position: 0.0, beatsToNext: 16 },
        { position: 4.0, bpm: 140.0 },
      ]));

      const bpm = getBpmFromBeatgrid(beatgrid);
      expect(bpm).toBeCloseTo(140.0, 2);
    });
  });

  describe('isDynamicBeatgrid', () => {
    it('returns false for empty beatgrid', () => {
      expect(isDynamicBeatgrid({ markers: [] })).toBe(false);
    });

    it('returns false for single marker', () => {
      const beatgrid = parseBeatgrid(createBeatgridBuffer([
        { position: 0.0, bpm: 128.0 },
      ]));

      expect(isDynamicBeatgrid(beatgrid)).toBe(false);
    });

    it('returns true for multiple markers', () => {
      const beatgrid = parseBeatgrid(createBeatgridBuffer([
        { position: 0.0, beatsToNext: 16 },
        { position: 4.0, bpm: 140.0 },
      ]));

      expect(isDynamicBeatgrid(beatgrid)).toBe(true);
    });
  });
});
