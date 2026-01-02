/**
 * Serato32 encoding utilities.
 *
 * Serato uses a custom 32-bit encoding format for storing 3-byte values (like RGB colors
 * and cue positions) in the Serato Markers_ tag. This format inserts a null bit after
 * every 7 payload bits, transforming 3 bytes (24 bits) into 4 bytes (32 bits).
 *
 * Algorithm and format documentation based on:
 * - triseratops by @Holzhaus: https://github.com/Holzhaus/triseratops
 *   Licensed under Mozilla Public License 2.0
 *   Source: https://holzhaus.github.io/triseratops/src/triseratops/tag/serato32.rs.html
 *
 * @module encoding/serato32
 */

/**
 * Decode 4 Serato32-encoded bytes into 3 plaintext bytes.
 *
 * The format stores 7 bits of payload in each byte (bit 7 is always 0).
 * This reverses the encoding by extracting and recombining the 7-bit chunks.
 *
 * @param enc1 - First encoded byte
 * @param enc2 - Second encoded byte
 * @param enc3 - Third encoded byte
 * @param enc4 - Fourth encoded byte
 * @returns Tuple of 3 decoded bytes
 */
export function decode(
  enc1: number,
  enc2: number,
  enc3: number,
  enc4: number
): [number, number, number] {
  const dec3 = (enc4 & 0x7f) | ((enc3 & 0x01) << 7);
  const dec2 = ((enc3 & 0x7f) >> 1) | ((enc2 & 0x03) << 6);
  const dec1 = ((enc2 & 0x7f) >> 2) | ((enc1 & 0x07) << 5);
  return [dec1, dec2, dec3];
}

/**
 * Encode 3 plaintext bytes into 4 Serato32-encoded bytes.
 *
 * Distributes 24 bits of input across 4 bytes, with 7 payload bits each.
 * Bit 7 of each output byte is always 0.
 *
 * @param dec1 - First plaintext byte
 * @param dec2 - Second plaintext byte
 * @param dec3 - Third plaintext byte
 * @returns Tuple of 4 encoded bytes
 */
export function encode(
  dec1: number,
  dec2: number,
  dec3: number
): [number, number, number, number] {
  const enc4 = dec3 & 0x7f;
  const enc3 = ((dec3 >> 7) | (dec2 << 1)) & 0x7f;
  const enc2 = ((dec2 >> 6) | (dec1 << 2)) & 0x7f;
  const enc1 = dec1 >> 5;
  return [enc1, enc2, enc3, enc4];
}

/**
 * Decode a Serato32-encoded buffer into plaintext bytes.
 *
 * Every 4 input bytes become 3 output bytes. Input length must be a multiple of 4.
 *
 * @param input - Buffer containing Serato32-encoded data
 * @returns Buffer containing decoded plaintext data
 * @throws Error if input length is not a multiple of 4
 */
export function decodeBuffer(input: Buffer): Buffer {
  if (input.length % 4 !== 0) {
    throw new Error(
      `Serato32 input length must be a multiple of 4, got ${input.length}`
    );
  }

  const outputLength = (input.length / 4) * 3;
  const output = Buffer.alloc(outputLength);

  for (let i = 0, j = 0; i < input.length; i += 4, j += 3) {
    const [dec1, dec2, dec3] = decode(
      input[i],
      input[i + 1],
      input[i + 2],
      input[i + 3]
    );
    output[j] = dec1;
    output[j + 1] = dec2;
    output[j + 2] = dec3;
  }

  return output;
}

/**
 * Encode a plaintext buffer into Serato32 format.
 *
 * Every 3 input bytes become 4 output bytes. Input length must be a multiple of 3.
 *
 * @param input - Buffer containing plaintext data
 * @returns Buffer containing Serato32-encoded data
 * @throws Error if input length is not a multiple of 3
 */
export function encodeBuffer(input: Buffer): Buffer {
  if (input.length % 3 !== 0) {
    throw new Error(
      `Serato32 input length must be a multiple of 3, got ${input.length}`
    );
  }

  const outputLength = (input.length / 3) * 4;
  const output = Buffer.alloc(outputLength);

  for (let i = 0, j = 0; i < input.length; i += 3, j += 4) {
    const [enc1, enc2, enc3, enc4] = encode(input[i], input[i + 1], input[i + 2]);
    output[j] = enc1;
    output[j + 1] = enc2;
    output[j + 2] = enc3;
    output[j + 3] = enc4;
  }

  return output;
}

/**
 * Decode a Serato32-encoded u32 value (4 bytes) into a 24-bit number.
 *
 * Used for decoding cue positions which are stored as Serato32-encoded timestamps.
 *
 * @param buffer - Buffer containing at least 4 bytes
 * @param offset - Offset to read from (default: 0)
 * @returns Decoded 24-bit value as a number
 */
export function decodeU32(buffer: Buffer, offset: number = 0): number {
  const [dec1, dec2, dec3] = decode(
    buffer[offset],
    buffer[offset + 1],
    buffer[offset + 2],
    buffer[offset + 3]
  );
  return (dec1 << 16) | (dec2 << 8) | dec3;
}

/**
 * Encode a 24-bit number into a Serato32-encoded u32 value (4 bytes).
 *
 * @param value - 24-bit value to encode (0-16777215)
 * @returns Buffer containing 4 encoded bytes
 */
export function encodeU32(value: number): Buffer {
  const dec1 = (value >> 16) & 0xff;
  const dec2 = (value >> 8) & 0xff;
  const dec3 = value & 0xff;
  const [enc1, enc2, enc3, enc4] = encode(dec1, dec2, dec3);
  return Buffer.from([enc1, enc2, enc3, enc4]);
}

/**
 * Color represented as RGB values.
 */
export interface SeratoColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Decode a Serato32-encoded color (4 bytes) into RGB values.
 *
 * @param buffer - Buffer containing at least 4 bytes
 * @param offset - Offset to read from (default: 0)
 * @returns Decoded color as RGB object
 */
export function decodeColor(buffer: Buffer, offset: number = 0): SeratoColor {
  const [r, g, b] = decode(
    buffer[offset],
    buffer[offset + 1],
    buffer[offset + 2],
    buffer[offset + 3]
  );
  return { r, g, b };
}

/**
 * Encode an RGB color into Serato32 format (4 bytes).
 *
 * @param color - Color as RGB object
 * @returns Buffer containing 4 encoded bytes
 */
export function encodeColor(color: SeratoColor): Buffer {
  const [enc1, enc2, enc3, enc4] = encode(color.r, color.g, color.b);
  return Buffer.from([enc1, enc2, enc3, enc4]);
}
