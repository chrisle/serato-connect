/**
 * Tests for Serato32 encoding utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  decode,
  encode,
  decodeBuffer,
  encodeBuffer,
  decodeU32,
  encodeU32,
  decodeColor,
  encodeColor,
} from '../../src/encoding/serato32.js';

describe('Serato32 encoding', () => {
  describe('decode', () => {
    it('decodes 4 bytes to 3 bytes', () => {
      // Example from triseratops: encoded [0x00, 0x00, 0x01, 0x4C] = decoded [0x00, 0x00, 0xCC]
      const [d1, d2, d3] = decode(0x00, 0x00, 0x01, 0x4c);
      expect(d1).toBe(0x00);
      expect(d2).toBe(0x00);
      expect(d3).toBe(0xcc);
    });

    it('decodes all zeros', () => {
      const [d1, d2, d3] = decode(0x00, 0x00, 0x00, 0x00);
      expect(d1).toBe(0x00);
      expect(d2).toBe(0x00);
      expect(d3).toBe(0x00);
    });

    it('decodes maximum values', () => {
      // Maximum 7-bit values in each position
      const [d1, d2, d3] = decode(0x07, 0x7f, 0x7f, 0x7f);
      expect(d1).toBe(0xff);
      expect(d2).toBe(0xff);
      expect(d3).toBe(0xff);
    });

    it('decodes color value correctly', () => {
      // Red color: RGB(204, 0, 0) -> encoded as [0x06, 0x30, 0x00, 0x00]
      const [r, g, b] = decode(0x06, 0x30, 0x00, 0x00);
      expect(r).toBe(0xcc);
      expect(g).toBe(0x00);
      expect(b).toBe(0x00);
    });
  });

  describe('encode', () => {
    it('encodes 3 bytes to 4 bytes', () => {
      const [e1, e2, e3, e4] = encode(0x00, 0x00, 0xcc);
      expect(e1).toBe(0x00);
      expect(e2).toBe(0x00);
      expect(e3).toBe(0x01);
      expect(e4).toBe(0x4c);
    });

    it('encodes all zeros', () => {
      const [e1, e2, e3, e4] = encode(0x00, 0x00, 0x00);
      expect(e1).toBe(0x00);
      expect(e2).toBe(0x00);
      expect(e3).toBe(0x00);
      expect(e4).toBe(0x00);
    });

    it('encodes maximum values', () => {
      const [e1, e2, e3, e4] = encode(0xff, 0xff, 0xff);
      expect(e1).toBe(0x07);
      expect(e2).toBe(0x7f);
      expect(e3).toBe(0x7f);
      expect(e4).toBe(0x7f);
    });

    it('round-trips correctly', () => {
      const original = [0xab, 0xcd, 0xef];
      const encoded = encode(original[0], original[1], original[2]);
      const decoded = decode(encoded[0], encoded[1], encoded[2], encoded[3]);
      expect(decoded).toEqual(original);
    });
  });

  describe('decodeBuffer', () => {
    it('decodes a buffer of encoded bytes', () => {
      const input = Buffer.from([0x00, 0x00, 0x01, 0x4c, 0x00, 0x00, 0x00, 0x00]);
      const output = decodeBuffer(input);
      expect(output.length).toBe(6);
      expect(output[0]).toBe(0x00);
      expect(output[1]).toBe(0x00);
      expect(output[2]).toBe(0xcc);
      expect(output[3]).toBe(0x00);
      expect(output[4]).toBe(0x00);
      expect(output[5]).toBe(0x00);
    });

    it('throws on invalid length', () => {
      const input = Buffer.from([0x00, 0x00, 0x01]);
      expect(() => decodeBuffer(input)).toThrow('multiple of 4');
    });
  });

  describe('encodeBuffer', () => {
    it('encodes a buffer of plaintext bytes', () => {
      const input = Buffer.from([0x00, 0x00, 0xcc]);
      const output = encodeBuffer(input);
      expect(output.length).toBe(4);
      expect(output[0]).toBe(0x00);
      expect(output[1]).toBe(0x00);
      expect(output[2]).toBe(0x01);
      expect(output[3]).toBe(0x4c);
    });

    it('throws on invalid length', () => {
      const input = Buffer.from([0x00, 0x00]);
      expect(() => encodeBuffer(input)).toThrow('multiple of 3');
    });

    it('round-trips correctly', () => {
      const original = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
      const encoded = encodeBuffer(original);
      const decoded = decodeBuffer(encoded);
      expect(decoded).toEqual(original);
    });
  });

  describe('decodeU32', () => {
    it('decodes a 24-bit value from 4 encoded bytes', () => {
      // Position value example
      const buffer = Buffer.from([0x00, 0x00, 0x01, 0x4c]);
      const value = decodeU32(buffer);
      expect(value).toBe(0x0000cc);
    });

    it('supports offset parameter', () => {
      const buffer = Buffer.from([0xff, 0xff, 0x00, 0x00, 0x01, 0x4c]);
      const value = decodeU32(buffer, 2);
      expect(value).toBe(0x0000cc);
    });
  });

  describe('encodeU32', () => {
    it('encodes a 24-bit value to 4 bytes', () => {
      const buffer = encodeU32(0x0000cc);
      expect(buffer.length).toBe(4);
      expect(buffer[0]).toBe(0x00);
      expect(buffer[1]).toBe(0x00);
      expect(buffer[2]).toBe(0x01);
      expect(buffer[3]).toBe(0x4c);
    });

    it('round-trips correctly', () => {
      const original = 0x123456;
      const encoded = encodeU32(original);
      const decoded = decodeU32(encoded);
      expect(decoded).toBe(original);
    });
  });

  describe('decodeColor', () => {
    it('decodes RGB color from 4 encoded bytes', () => {
      // Red: RGB(204, 0, 0) encoded as [0x06, 0x30, 0x00, 0x00]
      const buffer = Buffer.from([0x06, 0x30, 0x00, 0x00]);
      const color = decodeColor(buffer);
      expect(color.r).toBe(0xcc);
      expect(color.g).toBe(0x00);
      expect(color.b).toBe(0x00);
    });

    it('supports offset parameter', () => {
      const buffer = Buffer.from([0xff, 0xff, 0x06, 0x30, 0x00, 0x00]);
      const color = decodeColor(buffer, 2);
      expect(color.r).toBe(0xcc);
      expect(color.g).toBe(0x00);
      expect(color.b).toBe(0x00);
    });
  });

  describe('encodeColor', () => {
    it('encodes RGB color to 4 bytes', () => {
      const buffer = encodeColor({ r: 0xcc, g: 0x00, b: 0x00 });
      expect(buffer.length).toBe(4);
      expect(buffer[0]).toBe(0x06);
      expect(buffer[1]).toBe(0x30);
      expect(buffer[2]).toBe(0x00);
      expect(buffer[3]).toBe(0x00);
    });

    it('round-trips correctly', () => {
      const original = { r: 0xab, g: 0xcd, b: 0xef };
      const encoded = encodeColor(original);
      const decoded = decodeColor(encoded);
      expect(decoded.r).toBe(original.r);
      expect(decoded.g).toBe(original.g);
      expect(decoded.b).toBe(original.b);
    });
  });
});
