/**
 * Parse Serato Markers2 GEOB frame data.
 *
 * Serato Markers2 contains cue points, loops, flip recordings, track color,
 * and BPM lock status. The format uses base64 encoding with a specific binary
 * structure for each marker type.
 *
 * Format documentation and parsing algorithm based on:
 * - serato-tags by @Holzhaus: https://github.com/Holzhaus/serato-tags
 *   Docs: https://github.com/Holzhaus/serato-tags/blob/main/docs/serato_markers2.md
 * - serato-tools by @bvandercar-vt: https://github.com/bvandercar-vt/serato-tools
 *   Source: https://github.com/bvandercar-vt/serato-tools/blob/main/serato/markers.py
 * - triseratops by @Holzhaus: https://github.com/Holzhaus/triseratops
 *   Source: https://holzhaus.github.io/triseratops/src/triseratops/tag/markers2.rs.html
 *
 * @module parsers/geob/markers2
 */

import {
  SeratoMarkers2,
  SeratoCuePoint,
  SeratoLoop,
  SeratoFlip,
  SeratoFlipAction,
  SeratoColor,
} from '../../types.js';

/**
 * Header bytes at the start of Markers2 data (before and after base64 decoding).
 */
const HEADER = Buffer.from([0x01, 0x01]);

/**
 * Read a null-terminated string from a buffer.
 */
function readNullTerminatedString(
  buffer: Buffer,
  offset: number
): { value: string; bytesRead: number } {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }
  const value = buffer.subarray(offset, end).toString('utf8');
  return { value, bytesRead: end - offset + 1 }; // +1 for null terminator
}

/**
 * Parse a CUE entry from Markers2 data.
 *
 * CUE structure (from serato-tags docs):
 * - 1 byte: padding
 * - 1 byte: index
 * - 4 bytes: position (ms)
 * - 1 byte: padding
 * - 3 bytes: RGB color
 * - 2 bytes: padding
 * - 1-51 bytes: name (null-terminated UTF-8)
 */
function parseCue(data: Buffer): SeratoCuePoint {
  const index = data.readUInt8(1);
  const position = data.readUInt32BE(2);
  const r = data.readUInt8(7);
  const g = data.readUInt8(8);
  const b = data.readUInt8(9);

  let name: string | undefined;
  if (data.length > 12) {
    const { value } = readNullTerminatedString(data, 12);
    if (value) {
      name = value;
    }
  }

  return {
    index,
    position,
    color: { r, g, b },
    name,
  };
}

/**
 * Parse a LOOP entry from Markers2 data.
 *
 * LOOP structure (from serato-tags docs):
 * - 1 byte: padding
 * - 1 byte: index
 * - 4 bytes: start position (ms)
 * - 4 bytes: end position (ms)
 * - 4 bytes: padding
 * - 4 bytes: ARGB color
 * - 3 bytes: padding
 * - 1 byte: locked (boolean)
 * - 1-N bytes: name (null-terminated UTF-8)
 */
function parseLoop(data: Buffer): SeratoLoop {
  const index = data.readUInt8(1);
  const startPosition = data.readUInt32BE(2);
  const endPosition = data.readUInt32BE(6);
  // Skip 4 bytes padding at offset 10

  const a = data.readUInt8(14);
  const r = data.readUInt8(15);
  const g = data.readUInt8(16);
  const b = data.readUInt8(17);
  // Skip 3 bytes padding at offset 18
  const locked = data.readUInt8(21) !== 0;

  let name: string | undefined;
  if (data.length > 22) {
    const { value } = readNullTerminatedString(data, 22);
    if (value) {
      name = value;
    }
  }

  return {
    index,
    startPosition,
    endPosition,
    color: { r, g, b, a },
    locked,
    name,
  };
}

/**
 * Parse a FLIP entry from Markers2 data.
 *
 * FLIP structure (from serato-tags docs):
 * - 1 byte: padding
 * - 1 byte: index
 * - 1 byte: enabled (boolean)
 * - 1-11 bytes: name (null-terminated UTF-8)
 * - 1 byte: loop (boolean)
 * - 4 bytes: subentry count
 * - Variable: subentries
 */
function parseFlip(data: Buffer): SeratoFlip {
  const index = data.readUInt8(1);
  const enabled = data.readUInt8(2) !== 0;

  const { value: name, bytesRead } = readNullTerminatedString(data, 3);
  let offset = 3 + bytesRead;

  const loop = data.readUInt8(offset) !== 0;
  offset += 1;

  const actionCount = data.readUInt32BE(offset);
  offset += 4;

  const actions: SeratoFlipAction[] = [];

  for (let i = 0; i < actionCount; i++) {
    const type = data.readUInt8(offset);
    const length = data.readUInt32BE(offset + 1);
    offset += 5;

    if (type === 0) {
      // Jump action: 16 bytes (2 doubles)
      const sourcePosition = data.readDoubleBE(offset);
      const targetPosition = data.readDoubleBE(offset + 8);
      actions.push({
        type: 'jump',
        sourcePosition,
        targetPosition,
      });
    } else if (type === 1) {
      // Censor action: 24 bytes (3 doubles)
      const sourcePosition = data.readDoubleBE(offset);
      const targetPosition = data.readDoubleBE(offset + 8);
      const speedFactor = data.readDoubleBE(offset + 16);
      actions.push({
        type: 'censor',
        sourcePosition,
        targetPosition,
        speedFactor,
      });
    }

    offset += length;
  }

  return {
    index,
    enabled,
    name,
    loop,
    actions,
  };
}

/**
 * Parse a COLOR entry from Markers2 data.
 *
 * COLOR structure (from serato-tags docs):
 * - 1 byte: padding
 * - 3 bytes: RGB color
 */
function parseColor(data: Buffer): SeratoColor {
  return {
    r: data.readUInt8(1),
    g: data.readUInt8(2),
    b: data.readUInt8(3),
  };
}

/**
 * Parse a BPMLOCK entry from Markers2 data.
 *
 * BPMLOCK structure (from serato-tags docs):
 * - 1 byte: locked (boolean)
 */
function parseBpmLock(data: Buffer): boolean {
  return data.readUInt8(0) !== 0;
}

/**
 * Parse the raw binary content of a Serato Markers2 frame.
 *
 * The data should already be decoded from base64 if it came from FLAC/Ogg.
 * For MP3/AIFF, the data comes directly from the GEOB frame.
 *
 * Structure:
 * - 2 bytes: header (0x01 0x01)
 * - Variable: marker entries (type string + length + data)
 * - 1 byte: null terminator
 *
 * @param data - Raw binary data (after base64 decoding if applicable)
 * @returns Parsed Markers2 data
 */
export function parseMarkers2(data: Buffer): SeratoMarkers2 {
  const result: SeratoMarkers2 = {
    cuePoints: [],
    loops: [],
    flips: [],
  };

  // Skip header if present
  let offset = 0;
  if (data.length >= 2 && data[0] === HEADER[0] && data[1] === HEADER[1]) {
    offset = 2;
  }

  while (offset < data.length) {
    // Check for null terminator
    if (data[offset] === 0) {
      break;
    }

    // Read entry type (null-terminated string)
    const { value: entryType, bytesRead: typeLen } = readNullTerminatedString(
      data,
      offset
    );
    offset += typeLen;

    if (offset + 4 > data.length) {
      break;
    }

    // Read entry data length
    const entryLength = data.readUInt32BE(offset);
    offset += 4;

    if (offset + entryLength > data.length) {
      break;
    }

    // Extract entry data
    const entryData = data.subarray(offset, offset + entryLength);
    offset += entryLength;

    // Parse based on entry type
    switch (entryType) {
      case 'CUE':
        result.cuePoints.push(parseCue(entryData));
        break;
      case 'LOOP':
        result.loops.push(parseLoop(entryData));
        break;
      case 'FLIP':
        result.flips.push(parseFlip(entryData));
        break;
      case 'COLOR':
        result.trackColor = parseColor(entryData);
        break;
      case 'BPMLOCK':
        result.bpmLock = parseBpmLock(entryData);
        break;
      // Unknown entry types are silently ignored
    }
  }

  // Sort by index
  result.cuePoints.sort((a, b) => a.index - b.index);
  result.loops.sort((a, b) => a.index - b.index);
  result.flips.sort((a, b) => a.index - b.index);

  return result;
}

/**
 * Parse Markers2 data from a base64-encoded string (FLAC/Ogg format).
 *
 * The string may contain linebreaks (inserted every 72 chars by Serato).
 *
 * @param base64Data - Base64-encoded Markers2 data with possible linebreaks
 * @returns Parsed Markers2 data
 */
export function parseMarkers2FromBase64(base64Data: string): SeratoMarkers2 {
  // Remove linebreaks and decode
  let cleaned = base64Data.replace(/\s/g, '');

  // Handle potential 1-byte overflow mentioned in docs
  // If length % 4 == 1, we need to append 'A==' to decode properly
  const remainder = cleaned.length % 4;
  if (remainder === 1) {
    cleaned = cleaned.slice(0, -1); // Remove trailing byte
  } else if (remainder === 2) {
    cleaned += '==';
  } else if (remainder === 3) {
    cleaned += '=';
  }

  const buffer = Buffer.from(cleaned, 'base64');
  return parseMarkers2(buffer);
}

/**
 * Parse Markers2 data from an ID3 GEOB frame payload.
 *
 * For MP3/AIFF, the GEOB frame contains:
 * - 2 bytes: header (0x01 0x01)
 * - Base64-encoded content
 * - Null padding to minimum 470 bytes
 *
 * @param geobPayload - Raw GEOB frame payload (after frame header)
 * @returns Parsed Markers2 data
 */
export function parseMarkers2FromGeob(geobPayload: Buffer): SeratoMarkers2 {
  // Check for header
  if (geobPayload.length < 2) {
    return { cuePoints: [], loops: [], flips: [] };
  }

  // Skip header if present
  let offset = 0;
  if (geobPayload[0] === HEADER[0] && geobPayload[1] === HEADER[1]) {
    offset = 2;
  }

  // Find end of base64 data (before null padding)
  let end = geobPayload.length;
  while (end > offset && geobPayload[end - 1] === 0) {
    end--;
  }

  // Extract and decode base64 content
  const base64Content = geobPayload.subarray(offset, end).toString('ascii');
  return parseMarkers2FromBase64(base64Content);
}
