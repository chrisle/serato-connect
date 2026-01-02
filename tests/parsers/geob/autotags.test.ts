/**
 * Tests for Serato Autotags parser.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAutotags,
  parseAutotagsFromBase64,
} from '../../../src/parsers/geob/autotags.js';

describe('Autotags parser', () => {
  /**
   * Create an autotags buffer with the given values.
   */
  function createAutotagsBuffer(bpm: string, autoGain: string, gainDb: string): Buffer {
    // Pad strings to expected sizes
    const bpmPadded = bpm.padEnd(6, '\0') + '\0';      // 7 bytes
    const gainPadded = autoGain.padEnd(6, '\0') + '\0'; // 7 bytes
    const dbPadded = gainDb.padEnd(5, '\0') + '\0';    // 6 bytes

    return Buffer.concat([
      Buffer.from([0x01, 0x01]), // Header
      Buffer.from(bpmPadded, 'ascii'),
      Buffer.from(gainPadded, 'ascii'),
      Buffer.from(dbPadded, 'ascii'),
    ]);
  }

  describe('parseAutotags', () => {
    it('returns zeros for empty buffer', () => {
      const result = parseAutotags(Buffer.alloc(0));
      expect(result.bpm).toBe(0);
      expect(result.autoGain).toBe(0);
      expect(result.gainDb).toBe(0);
    });

    it('parses autotags with typical values', () => {
      const buffer = createAutotagsBuffer('128.00', '-3.257', '0.000');
      const result = parseAutotags(buffer);

      expect(result.bpm).toBeCloseTo(128.0, 2);
      expect(result.autoGain).toBeCloseTo(-3.257, 3);
      expect(result.gainDb).toBeCloseTo(0.0, 3);
    });

    it('parses fractional BPM', () => {
      const buffer = createAutotagsBuffer('128.50', '0.000', '0.000');
      const result = parseAutotags(buffer);

      expect(result.bpm).toBeCloseTo(128.5, 2);
    });

    it('parses negative auto gain', () => {
      const buffer = createAutotagsBuffer('120.00', '-5.500', '1.200');
      const result = parseAutotags(buffer);

      expect(result.autoGain).toBeCloseTo(-5.5, 3);
      expect(result.gainDb).toBeCloseTo(1.2, 3);
    });

    it('parses positive auto gain', () => {
      const buffer = createAutotagsBuffer('140.00', '2.500', '-0.500');
      const result = parseAutotags(buffer);

      expect(result.autoGain).toBeCloseTo(2.5, 3);
      expect(result.gainDb).toBeCloseTo(-0.5, 3);
    });

    it('handles buffer without header', () => {
      const bpmPadded = '115.00'.padEnd(6, '\0') + '\0';
      const gainPadded = '-2.000'.padEnd(6, '\0') + '\0';
      const dbPadded = '0.500'.padEnd(5, '\0') + '\0';

      const buffer = Buffer.concat([
        Buffer.from(bpmPadded, 'ascii'),
        Buffer.from(gainPadded, 'ascii'),
        Buffer.from(dbPadded, 'ascii'),
      ]);

      const result = parseAutotags(buffer);
      expect(result.bpm).toBeCloseTo(115.0, 2);
    });

    it('returns 0 for invalid/unparseable values', () => {
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]),
        Buffer.from('INVALID', 'ascii'),
      ]);

      const result = parseAutotags(buffer);
      expect(result.bpm).toBe(0);
    });
  });

  describe('parseAutotagsFromBase64', () => {
    it('decodes and parses base64 data', () => {
      const buffer = createAutotagsBuffer('128.00', '-3.000', '0.000');
      const base64 = buffer.toString('base64');

      const result = parseAutotagsFromBase64(base64);
      expect(result.bpm).toBeCloseTo(128.0, 2);
      expect(result.autoGain).toBeCloseTo(-3.0, 3);
    });

    it('handles base64 with linebreaks', () => {
      const buffer = createAutotagsBuffer('120.00', '0.000', '0.000');
      let base64 = buffer.toString('base64');
      base64 = base64.slice(0, 10) + '\n' + base64.slice(10);

      const result = parseAutotagsFromBase64(base64);
      expect(result.bpm).toBeCloseTo(120.0, 2);
    });

    it('handles base64 without padding', () => {
      const buffer = createAutotagsBuffer('130.00', '1.500', '0.000');
      const base64 = buffer.toString('base64').replace(/=+$/, '');

      const result = parseAutotagsFromBase64(base64);
      expect(result.bpm).toBeCloseTo(130.0, 2);
    });
  });
});
