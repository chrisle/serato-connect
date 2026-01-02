/**
 * Base64 encoding utilities for Serato metadata in FLAC/Ogg files.
 *
 * Serato stores metadata in FLAC and Ogg Vorbis files using Vorbis comments.
 * The field data is base64-encoded without padding and linefeeds (\n) are
 * inserted after every 72 characters.
 *
 * Format documentation based on:
 * - serato-tags by @Holzhaus: https://github.com/Holzhaus/serato-tags
 *   Docs: https://github.com/Holzhaus/serato-tags/blob/main/docs/fileformats.md
 * - triseratops by @Holzhaus: https://github.com/Holzhaus/triseratops
 *   Licensed under Mozilla Public License 2.0
 *
 * @module encoding/base64
 */

/**
 * Number of characters per line in Serato's base64 format.
 * Linefeeds are inserted after every 72 characters.
 */
const LINE_LENGTH = 72;

/**
 * Encode a buffer to Serato-style base64 with linebreaks.
 *
 * - Uses standard base64 encoding (no URL-safe variant)
 * - Removes padding characters (=)
 * - Inserts newline after every 72 characters
 *
 * @param input - Buffer to encode
 * @returns Base64-encoded string with linebreaks
 */
export function encodeWithLinebreaks(input: Buffer): string {
  // Standard base64 encoding without padding
  let base64 = input.toString('base64').replace(/=+$/, '');

  // Insert newlines every 72 characters
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += LINE_LENGTH) {
    lines.push(base64.slice(i, i + LINE_LENGTH));
  }

  return lines.join('\n');
}

/**
 * Decode Serato-style base64 with linebreaks to a buffer.
 *
 * - Removes all newline characters
 * - Handles missing padding (adds = as needed)
 *
 * @param input - Base64-encoded string (may contain linebreaks)
 * @returns Decoded buffer
 */
export function decodeWithLinebreaks(input: string): Buffer {
  // Remove all whitespace including newlines
  let base64 = input.replace(/\s/g, '');

  // Add padding if necessary
  const paddingNeeded = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(paddingNeeded);

  return Buffer.from(base64, 'base64');
}

/**
 * Check if a string appears to be Serato-style base64 encoded.
 *
 * Serato base64 strings:
 * - Contain only base64 characters and newlines
 * - Have linebreaks at regular intervals (typically 72 chars)
 * - Don't end with padding (= characters)
 *
 * @param input - String to check
 * @returns True if the string appears to be Serato base64
 */
export function isSeratoBase64(input: string): boolean {
  // Remove newlines for checking
  const cleaned = input.replace(/\n/g, '');

  // Check if it's valid base64 characters (without padding)
  return /^[A-Za-z0-9+/]*$/.test(cleaned) && cleaned.length > 0;
}
