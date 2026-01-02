/**
 * Encoding utilities for Serato metadata.
 *
 * @module encoding
 */

export {
  decode as decodeSerato32,
  encode as encodeSerato32,
  decodeBuffer as decodeSerato32Buffer,
  encodeBuffer as encodeSerato32Buffer,
  decodeU32 as decodeSerato32U32,
  encodeU32 as encodeSerato32U32,
  decodeColor as decodeSerato32Color,
  encodeColor as encodeSerato32Color,
  type SeratoColor,
} from './serato32.js';

export {
  encodeWithLinebreaks,
  decodeWithLinebreaks,
  isSeratoBase64,
} from './base64.js';
