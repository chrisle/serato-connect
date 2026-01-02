/**
 * GEOB frame parsers for Serato metadata.
 *
 * Serato stores track metadata in GEOB (General Encapsulated Object) frames
 * within ID3v2 tags (for MP3/AIFF) or Vorbis comments (for FLAC/Ogg).
 *
 * @module parsers/geob
 */

export {
  parseMarkers2,
  parseMarkers2FromBase64,
  parseMarkers2FromGeob,
} from './markers2.js';

export {
  parseBeatgrid,
  parseBeatgridFromBase64,
  getBpmFromBeatgrid,
  isDynamicBeatgrid,
} from './beatgrid.js';

export {
  parseAutotags,
  parseAutotagsFromBase64,
} from './autotags.js';
