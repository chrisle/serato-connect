/**
 * Parse Serato Autotags GEOB frame data.
 *
 * Serato Autotags contains auto-analyzed values: BPM, auto gain, and gain in dB.
 * Unlike other Serato tags, the values are stored as ASCII strings rather than
 * binary floats.
 *
 * Format documentation and parsing algorithm based on:
 * - serato-tags by @Holzhaus: https://github.com/Holzhaus/serato-tags
 *   Docs: https://github.com/Holzhaus/serato-tags/blob/main/docs/serato_autotags.md
 * - serato-tools by @bvandercar-vt: https://github.com/bvandercar-vt/serato-tools
 *   Source: https://github.com/bvandercar-vt/serato-tools/blob/main/serato/autotags.py
 *
 * @module parsers/geob/autotags
 */

import { SeratoAutotags } from '../../types.js';

/**
 * Header bytes at the start of Autotags data.
 */
const HEADER = Buffer.from([0x01, 0x01]);

/**
 * Expected field sizes in bytes (including null terminator).
 */
const BPM_SIZE = 7; // e.g., "115.00" + null
const AUTOGAIN_SIZE = 7; // e.g., "-3.257" + null
const GAINDB_SIZE = 6; // e.g., "0.000" + null

/**
 * Read a null-terminated ASCII string from a buffer.
 */
function readAsciiString(
  buffer: Buffer,
  offset: number,
  maxLength: number
): string {
  let end = offset;
  const limit = Math.min(offset + maxLength, buffer.length);
  while (end < limit && buffer[end] !== 0) {
    end++;
  }
  return buffer.subarray(offset, end).toString('ascii');
}

/**
 * Parse raw Serato Autotags data.
 *
 * Structure (from serato-tags docs):
 * - 2 bytes: header (0x01 0x01)
 * - 7 bytes: BPM (null-terminated ASCII, e.g., "115.00")
 * - 7 bytes: Auto Gain (null-terminated ASCII, e.g., "-3.257")
 * - 6 bytes: Gain dB (null-terminated ASCII, e.g., "0.000")
 *
 * Total: 22 bytes
 *
 * @param data - Raw binary Autotags data
 * @returns Parsed Autotags data
 */
export function parseAutotags(data: Buffer): SeratoAutotags {
  const result: SeratoAutotags = {
    bpm: 0,
    autoGain: 0,
    gainDb: 0,
  };

  // Skip header if present
  let offset = 0;
  if (data.length >= 2 && data[0] === HEADER[0] && data[1] === HEADER[1]) {
    offset = 2;
  }

  // Parse BPM
  if (offset + BPM_SIZE <= data.length) {
    const bpmStr = readAsciiString(data, offset, BPM_SIZE);
    const bpm = parseFloat(bpmStr);
    if (!isNaN(bpm)) {
      result.bpm = bpm;
    }
    offset += BPM_SIZE;
  }

  // Parse Auto Gain
  if (offset + AUTOGAIN_SIZE <= data.length) {
    const autoGainStr = readAsciiString(data, offset, AUTOGAIN_SIZE);
    const autoGain = parseFloat(autoGainStr);
    if (!isNaN(autoGain)) {
      result.autoGain = autoGain;
    }
    offset += AUTOGAIN_SIZE;
  }

  // Parse Gain dB
  if (offset + GAINDB_SIZE <= data.length) {
    const gainDbStr = readAsciiString(data, offset, GAINDB_SIZE);
    const gainDb = parseFloat(gainDbStr);
    if (!isNaN(gainDb)) {
      result.gainDb = gainDb;
    }
  }

  return result;
}

/**
 * Parse Autotags data from a base64-encoded string (FLAC/Ogg format).
 *
 * @param base64Data - Base64-encoded Autotags data with possible linebreaks
 * @returns Parsed Autotags data
 */
export function parseAutotagsFromBase64(base64Data: string): SeratoAutotags {
  // Remove linebreaks and decode
  let cleaned = base64Data.replace(/\s/g, '');

  // Add padding if necessary
  const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
  cleaned += '='.repeat(paddingNeeded);

  const buffer = Buffer.from(cleaned, 'base64');
  return parseAutotags(buffer);
}
