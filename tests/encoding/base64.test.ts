/**
 * Tests for Serato-style Base64 encoding utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeWithLinebreaks,
  decodeWithLinebreaks,
  isSeratoBase64,
} from '../../src/encoding/base64.js';

describe('Base64 encoding', () => {
  describe('encodeWithLinebreaks', () => {
    it('encodes small buffer without linebreaks', () => {
      const input = Buffer.from('Hello');
      const result = encodeWithLinebreaks(input);
      expect(result).toBe('SGVsbG8');
      expect(result).not.toContain('\n');
      expect(result).not.toContain('='); // No padding
    });

    it('encodes buffer with linebreaks every 72 chars', () => {
      // Create a buffer that will produce more than 72 base64 chars
      const input = Buffer.alloc(60, 'A'.charCodeAt(0)); // 60 bytes -> 80 base64 chars
      const result = encodeWithLinebreaks(input);

      const lines = result.split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0].length).toBe(72);
    });

    it('removes padding', () => {
      // 1 byte -> 2 base64 chars + 2 padding normally
      const input = Buffer.from('A');
      const result = encodeWithLinebreaks(input);
      expect(result).toBe('QQ');
      expect(result).not.toContain('=');
    });
  });

  describe('decodeWithLinebreaks', () => {
    it('decodes base64 without linebreaks', () => {
      const input = 'SGVsbG8';
      const result = decodeWithLinebreaks(input);
      expect(result.toString()).toBe('Hello');
    });

    it('decodes base64 with linebreaks', () => {
      const input = 'SGVs\nbG8';
      const result = decodeWithLinebreaks(input);
      expect(result.toString()).toBe('Hello');
    });

    it('handles missing padding', () => {
      // 'QQ' would normally need '==' padding
      const input = 'QQ';
      const result = decodeWithLinebreaks(input);
      expect(result.toString()).toBe('A');
    });

    it('handles various padding scenarios', () => {
      // 2 chars (needs ==)
      expect(decodeWithLinebreaks('QQ').toString()).toBe('A');
      // 3 chars (needs =)
      expect(decodeWithLinebreaks('QUI').toString()).toBe('AB');
      // 4 chars (no padding needed)
      expect(decodeWithLinebreaks('QUJD').toString()).toBe('ABC');
    });

    it('removes all whitespace including tabs and spaces', () => {
      const input = 'SGVs bG8\t';
      const result = decodeWithLinebreaks(input);
      expect(result.toString()).toBe('Hello');
    });
  });

  describe('round-trip', () => {
    it('encodes and decodes correctly', () => {
      const original = Buffer.from('The quick brown fox jumps over the lazy dog');
      const encoded = encodeWithLinebreaks(original);
      const decoded = decodeWithLinebreaks(encoded);
      expect(decoded).toEqual(original);
    });

    it('handles binary data', () => {
      const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const encoded = encodeWithLinebreaks(original);
      const decoded = decodeWithLinebreaks(encoded);
      expect(decoded).toEqual(original);
    });

    it('handles large data with multiple linebreaks', () => {
      const original = Buffer.alloc(200, 0x42); // 200 bytes
      const encoded = encodeWithLinebreaks(original);
      const decoded = decodeWithLinebreaks(encoded);
      expect(decoded).toEqual(original);

      // Verify linebreaks were inserted
      expect(encoded).toContain('\n');
    });
  });

  describe('isSeratoBase64', () => {
    it('returns true for valid base64', () => {
      expect(isSeratoBase64('SGVsbG8')).toBe(true);
      expect(isSeratoBase64('QUJDREVG')).toBe(true);
    });

    it('returns true for base64 with linebreaks', () => {
      expect(isSeratoBase64('SGVs\nbG8')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isSeratoBase64('')).toBe(false);
    });

    it('returns false for invalid characters', () => {
      expect(isSeratoBase64('Hello!')).toBe(false);
      expect(isSeratoBase64('Hello World')).toBe(false); // space without newline context
    });

    it('returns false for padded base64', () => {
      // Serato base64 should not have padding
      expect(isSeratoBase64('QQ==')).toBe(false);
    });
  });
});
