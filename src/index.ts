/**
 * serato-connect - A comprehensive Serato DJ library and metadata reader.
 *
 * Features:
 * - Real-time history monitoring with events
 * - GEOB frame parsing (cue points, loops, beatgrid, colors)
 * - Audio file metadata reading (MP3, AIFF, FLAC, M4A)
 * - Crate and smart crate parsing
 * - Database V2 parsing for library access
 *
 * @module serato-connect
 */

// Main connector class
export {
  SeratoConnect,
  getDefaultSeratoPath,
  detectSeratoInstallation,
} from './seratoConnect.js';

// Core types
export type {
  SeratoConnectOptions,
  SeratoConnectEvents,
  SeratoHistorySong,
  SeratoSession,
  SeratoReadyInfo,
  SeratoTrackPayload,
  SeratoHistoryPayload,
  SeratoSessionPayload,
  // GEOB metadata types
  SeratoColor,
  SeratoCuePoint,
  SeratoLoop,
  SeratoFlip,
  SeratoFlipAction,
  SeratoBeatgridMarker,
  SeratoBeatgrid,
  SeratoAutotags,
  SeratoMarkers2,
  SeratoTrackMetadata,
} from './types.js';

// History parser exports
export {
  getSeratoHistory,
  getSessions,
  getSessionSongs,
  getLatestSessionPath,
  CHUNK_TAGS,
} from './historyParser.js';

// Encoding utilities
export {
  decodeSerato32,
  encodeSerato32,
  decodeSerato32Buffer,
  encodeSerato32Buffer,
  decodeSerato32U32,
  encodeSerato32U32,
  decodeSerato32Color,
  encodeSerato32Color,
  encodeWithLinebreaks,
  decodeWithLinebreaks,
  isSeratoBase64,
} from './encoding/index.js';

// GEOB parsers
export {
  parseMarkers2,
  parseMarkers2FromBase64,
  parseMarkers2FromGeob,
  parseBeatgrid,
  parseBeatgridFromBase64,
  getBpmFromBeatgrid,
  isDynamicBeatgrid,
  parseAutotags,
  parseAutotagsFromBase64,
} from './parsers/geob/index.js';

// Crate parser
export {
  parseCrate,
  parseCrateSync,
  listCrates,
  getAllCrates,
  findCratesForTrack,
  type SeratoCrate,
} from './parsers/crate.js';

// Database parser
export {
  parseDatabase,
  parseDatabaseSync,
  getLibraryTracks,
  getTrackByPath,
  searchLibrary,
  getDatabaseStats,
  type SeratoDatabaseTrack,
} from './parsers/database.js';

// Audio file reader
export {
  getTrackMetadata,
  getTrackMetadataFromBuffer,
} from './readers/index.js';
