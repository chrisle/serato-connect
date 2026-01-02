/**
 * Tests for Serato Markers2 parser.
 */

import { describe, it, expect } from 'vitest';
import { parseMarkers2, parseMarkers2FromBase64 } from '../../../src/parsers/geob/markers2.js';

describe('Markers2 parser', () => {
  describe('parseMarkers2', () => {
    it('returns empty result for empty buffer', () => {
      const result = parseMarkers2(Buffer.alloc(0));
      expect(result.cuePoints).toEqual([]);
      expect(result.loops).toEqual([]);
      expect(result.flips).toEqual([]);
      expect(result.trackColor).toBeUndefined();
      expect(result.bpmLock).toBeUndefined();
    });

    it('returns empty result for header-only buffer', () => {
      const buffer = Buffer.from([0x01, 0x01, 0x00]); // header + null terminator
      const result = parseMarkers2(buffer);
      expect(result.cuePoints).toEqual([]);
      expect(result.loops).toEqual([]);
    });

    it('parses COLOR entry', () => {
      // Header + COLOR + null terminator
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]), // Header
        Buffer.from('COLOR\0'), // Entry type
        Buffer.from([0x00, 0x00, 0x00, 0x04]), // Length: 4 bytes
        Buffer.from([0x00, 0xcc, 0x00, 0x00]), // Padding + RGB
        Buffer.from([0x00]), // Null terminator
      ]);

      const result = parseMarkers2(buffer);
      expect(result.trackColor).toEqual({ r: 0xcc, g: 0x00, b: 0x00 });
    });

    it('parses BPMLOCK entry', () => {
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]), // Header
        Buffer.from('BPMLOCK\0'), // Entry type
        Buffer.from([0x00, 0x00, 0x00, 0x01]), // Length: 1 byte
        Buffer.from([0x01]), // Locked = true
        Buffer.from([0x00]), // Null terminator
      ]);

      const result = parseMarkers2(buffer);
      expect(result.bpmLock).toBe(true);
    });

    it('parses CUE entry', () => {
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]), // Header
        Buffer.from('CUE\0'), // Entry type
        Buffer.from([0x00, 0x00, 0x00, 0x0d]), // Length: 13 bytes (minimum CUE)
        Buffer.from([0x00]), // Padding
        Buffer.from([0x02]), // Index: 2
        Buffer.from([0x00, 0x00, 0x03, 0xe8]), // Position: 1000ms
        Buffer.from([0x00]), // Padding
        Buffer.from([0xcc, 0x00, 0x00]), // Color: red
        Buffer.from([0x00, 0x00]), // Padding
        Buffer.from([0x00]), // Empty name (null terminator)
        Buffer.from([0x00]), // Entry null terminator
      ]);

      const result = parseMarkers2(buffer);
      expect(result.cuePoints.length).toBe(1);
      expect(result.cuePoints[0].index).toBe(2);
      expect(result.cuePoints[0].position).toBe(1000);
      expect(result.cuePoints[0].color).toEqual({ r: 0xcc, g: 0x00, b: 0x00 });
    });

    it('parses CUE entry with name', () => {
      const cueName = 'Drop';
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]), // Header
        Buffer.from('CUE\0'), // Entry type
        Buffer.from([0x00, 0x00, 0x00, 0x11]), // Length: 17 bytes
        Buffer.from([0x00]), // Padding
        Buffer.from([0x00]), // Index: 0
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // Position: 0ms
        Buffer.from([0x00]), // Padding
        Buffer.from([0x00, 0xff, 0x00]), // Color: green
        Buffer.from([0x00, 0x00]), // Padding
        Buffer.from(cueName + '\0'), // Name
        Buffer.from([0x00]), // Entry null terminator
      ]);

      const result = parseMarkers2(buffer);
      expect(result.cuePoints[0].name).toBe('Drop');
      expect(result.cuePoints[0].color).toEqual({ r: 0x00, g: 0xff, b: 0x00 });
    });

    it('parses LOOP entry', () => {
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]), // Header
        Buffer.from('LOOP\0'), // Entry type
        Buffer.from([0x00, 0x00, 0x00, 0x17]), // Length: 23 bytes
        Buffer.from([0x00]), // Padding
        Buffer.from([0x01]), // Index: 1
        Buffer.from([0x00, 0x00, 0x03, 0xe8]), // Start: 1000ms
        Buffer.from([0x00, 0x00, 0x07, 0xd0]), // End: 2000ms
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // Padding
        Buffer.from([0xff, 0x00, 0x00, 0xff]), // ARGB color
        Buffer.from([0x00, 0x00, 0x00]), // Padding
        Buffer.from([0x01]), // Locked: true
        Buffer.from([0x00]), // Empty name
        Buffer.from([0x00]), // Entry null terminator
      ]);

      const result = parseMarkers2(buffer);
      expect(result.loops.length).toBe(1);
      expect(result.loops[0].index).toBe(1);
      expect(result.loops[0].startPosition).toBe(1000);
      expect(result.loops[0].endPosition).toBe(2000);
      expect(result.loops[0].locked).toBe(true);
      expect(result.loops[0].color.a).toBe(0xff);
    });

    it('sorts cue points by index', () => {
      // Create buffer with CUE entries in reverse order (index 2, then index 0)
      const cue2 = Buffer.concat([
        Buffer.from('CUE\0'),
        Buffer.from([0x00, 0x00, 0x00, 0x0d]),
        Buffer.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ]);
      const cue0 = Buffer.concat([
        Buffer.from('CUE\0'),
        Buffer.from([0x00, 0x00, 0x00, 0x0d]),
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00]),
      ]);

      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]),
        cue2,
        cue0,
        Buffer.from([0x00]),
      ]);

      const result = parseMarkers2(buffer);
      expect(result.cuePoints.length).toBe(2);
      expect(result.cuePoints[0].index).toBe(0);
      expect(result.cuePoints[1].index).toBe(2);
    });

    it('ignores unknown entry types', () => {
      const buffer = Buffer.concat([
        Buffer.from([0x01, 0x01]), // Header
        Buffer.from('UNKNOWN\0'), // Unknown entry type
        Buffer.from([0x00, 0x00, 0x00, 0x04]), // Length: 4 bytes
        Buffer.from([0x01, 0x02, 0x03, 0x04]), // Data
        Buffer.from([0x00]), // Null terminator
      ]);

      const result = parseMarkers2(buffer);
      expect(result.cuePoints).toEqual([]);
      expect(result.loops).toEqual([]);
    });
  });

  describe('parseMarkers2FromBase64', () => {
    it('decodes and parses base64 data', () => {
      // Create a simple COLOR entry, encode to base64
      const rawData = Buffer.concat([
        Buffer.from([0x01, 0x01]),
        Buffer.from('COLOR\0'),
        Buffer.from([0x00, 0x00, 0x00, 0x04]),
        Buffer.from([0x00, 0xff, 0x00, 0x00]),
        Buffer.from([0x00]),
      ]);

      const base64 = rawData.toString('base64').replace(/=+$/, '');
      const result = parseMarkers2FromBase64(base64);

      expect(result.trackColor).toEqual({ r: 0xff, g: 0x00, b: 0x00 });
    });

    it('handles base64 with linebreaks', () => {
      const rawData = Buffer.concat([
        Buffer.from([0x01, 0x01]),
        Buffer.from('COLOR\0'),
        Buffer.from([0x00, 0x00, 0x00, 0x04]),
        Buffer.from([0x00, 0x00, 0xff, 0x00]),
        Buffer.from([0x00]),
      ]);

      // Add linebreaks to the base64
      let base64 = rawData.toString('base64').replace(/=+$/, '');
      base64 = base64.slice(0, 10) + '\n' + base64.slice(10);

      const result = parseMarkers2FromBase64(base64);
      expect(result.trackColor).toEqual({ r: 0x00, g: 0xff, b: 0x00 });
    });
  });
});
