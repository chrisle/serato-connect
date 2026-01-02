/**
 * Parse Serato BeatGrid GEOB frame data.
 *
 * Serato BeatGrid contains timing markers for beat synchronization. The format
 * uses a header with marker count, followed by marker entries, and a footer.
 *
 * The last marker is always a "terminal" marker that contains the BPM value.
 * All preceding markers are "non-terminal" and contain beat counts to the next marker.
 *
 * Format documentation and parsing algorithm based on:
 * - serato-tags by @Holzhaus: https://github.com/Holzhaus/serato-tags
 *   Docs: https://github.com/Holzhaus/serato-tags/blob/main/docs/serato_beatgrid.md
 * - serato-tools by @bvandercar-vt: https://github.com/bvandercar-vt/serato-tools
 *   Source: https://github.com/bvandercar-vt/serato-tools/blob/main/serato/beatgrid.py
 * - triseratops by @Holzhaus: https://github.com/Holzhaus/triseratops
 *   Source: https://holzhaus.github.io/triseratops/src/triseratops/tag/beatgrid.rs.html
 *
 * @module parsers/geob/beatgrid
 */

import { SeratoBeatgrid, SeratoBeatgridMarker } from '../../types.js';

/**
 * Size of the header in bytes.
 * - 2 bytes: unknown
 * - 4 bytes: marker count (uint32_t BE)
 */
const HEADER_SIZE = 6;

/**
 * Size of each marker in bytes.
 * - 4 bytes: position (float32 BE)
 * - 4 bytes: BPM or beats-to-next (float32 or uint32_t BE)
 */
const MARKER_SIZE = 8;

/**
 * Size of the footer in bytes.
 */
const FOOTER_SIZE = 1;

/**
 * Parse a terminal marker (the last marker, which contains BPM).
 */
function parseTerminalMarker(
  data: Buffer,
  offset: number
): SeratoBeatgridMarker {
  const position = data.readFloatBE(offset);
  const bpm = data.readFloatBE(offset + 4);
  return { position, bpm };
}

/**
 * Parse a non-terminal marker (contains beat count to next marker).
 */
function parseNonTerminalMarker(
  data: Buffer,
  offset: number
): SeratoBeatgridMarker {
  const position = data.readFloatBE(offset);
  const beatsToNext = data.readUInt32BE(offset + 4);
  return { position, beatsToNext };
}

/**
 * Parse raw Serato BeatGrid data.
 *
 * Structure (from serato-tags docs):
 * - Header (6 bytes):
 *   - 2 bytes: unknown
 *   - 4 bytes: marker count (uint32_t BE)
 * - Markers (8 bytes each):
 *   - 4 bytes: position in seconds (float32 BE)
 *   - 4 bytes: BPM (terminal) or beats-to-next (non-terminal)
 * - Footer (1 byte): unknown
 *
 * @param data - Raw binary BeatGrid data
 * @returns Parsed BeatGrid data
 */
export function parseBeatgrid(data: Buffer): SeratoBeatgrid {
  const result: SeratoBeatgrid = {
    markers: [],
  };

  if (data.length < HEADER_SIZE) {
    return result;
  }

  // Read marker count from header
  const markerCount = data.readUInt32BE(2);

  if (markerCount === 0) {
    return result;
  }

  // Validate data length
  const expectedLength = HEADER_SIZE + markerCount * MARKER_SIZE + FOOTER_SIZE;
  if (data.length < expectedLength - FOOTER_SIZE) {
    // Allow missing footer, but need all markers
    return result;
  }

  // Parse markers
  for (let i = 0; i < markerCount; i++) {
    const offset = HEADER_SIZE + i * MARKER_SIZE;
    const isTerminal = i === markerCount - 1;

    if (isTerminal) {
      result.markers.push(parseTerminalMarker(data, offset));
    } else {
      result.markers.push(parseNonTerminalMarker(data, offset));
    }
  }

  return result;
}

/**
 * Parse BeatGrid data from a base64-encoded string (FLAC/Ogg format).
 *
 * @param base64Data - Base64-encoded BeatGrid data with possible linebreaks
 * @returns Parsed BeatGrid data
 */
export function parseBeatgridFromBase64(base64Data: string): SeratoBeatgrid {
  // Remove linebreaks and decode
  let cleaned = base64Data.replace(/\s/g, '');

  // Add padding if necessary
  const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
  cleaned += '='.repeat(paddingNeeded);

  const buffer = Buffer.from(cleaned, 'base64');
  return parseBeatgrid(buffer);
}

/**
 * Get the effective BPM from a beatgrid.
 *
 * For simple beatgrids (single marker), returns that marker's BPM.
 * For complex beatgrids (multiple markers), returns the terminal marker's BPM.
 *
 * @param beatgrid - Parsed beatgrid data
 * @returns BPM value, or undefined if no markers
 */
export function getBpmFromBeatgrid(beatgrid: SeratoBeatgrid): number | undefined {
  if (beatgrid.markers.length === 0) {
    return undefined;
  }

  // The terminal marker (last one) has the BPM
  const terminalMarker = beatgrid.markers[beatgrid.markers.length - 1];
  return terminalMarker.bpm;
}

/**
 * Check if a beatgrid has dynamic tempo changes.
 *
 * A dynamic beatgrid has multiple markers, indicating tempo changes
 * throughout the track.
 *
 * @param beatgrid - Parsed beatgrid data
 * @returns True if the beatgrid has tempo changes
 */
export function isDynamicBeatgrid(beatgrid: SeratoBeatgrid): boolean {
  return beatgrid.markers.length > 1;
}
