import EventEmitter from 'node:events';
import type { StrictEventEmitter } from 'strict-event-emitter-types';

/**
 * Configuration options for SeratoConnect
 */
export type SeratoConnectOptions = {
  /** Custom path to the _Serato_ folder. If omitted, uses default location. */
  seratoPath?: string;
  /** How frequently to poll the history files (ms). Default: 2000 */
  pollIntervalMs?: number;
  /** Maximum number of history rows to emit per poll. Default: 100 */
  historyMaxRows?: number;
};

/**
 * A song entry from a Serato history session
 */
export interface SeratoHistorySong {
  /** Track title */
  title: string;
  /** Track artist */
  artist: string;
  /** Full file path to the track */
  filePath: string;
  /** BPM if available */
  bpm?: number;
  /** When the track started playing */
  startTime?: Date;
  /** When the track finished playing */
  playTime?: Date;
  /** Whether the track was marked as played */
  played?: boolean;
  /** Whether the track is currently playing */
  playing?: boolean;
  /** Deck number (1-4) */
  deck?: number;
}

/**
 * A Serato DJ session containing played tracks
 */
export interface SeratoSession {
  /** Session date string */
  date: string;
  /** Index/ID of the session */
  index: number;
  /** Songs played in this session */
  songs: SeratoHistorySong[];
}

/**
 * Info emitted when SeratoConnect is ready
 */
export type SeratoReadyInfo = {
  /** Path to the Serato folder */
  seratoPath: string;
  /** Number of sessions found */
  sessionCount: number;
};

/**
 * Payload for track events
 */
export type SeratoTrackPayload = {
  /** The track that changed */
  track: SeratoHistorySong;
  /** Which deck the track is on */
  deckId?: number;
};

/**
 * Payload for history events
 */
export type SeratoHistoryPayload = {
  /** Path to the Serato folder */
  seratoPath: string;
  /** Number of new tracks */
  count: number;
  /** The new tracks */
  tracks: SeratoHistorySong[];
};

/**
 * Payload for session events
 */
export type SeratoSessionPayload = {
  /** The session that was detected */
  session: SeratoSession;
};

/**
 * Events emitted by SeratoConnect
 */
export interface SeratoConnectEvents {
  /** Emitted when the connector is ready and has loaded initial data */
  ready: (info: SeratoReadyInfo) => void;
  /** Emitted on each poll cycle */
  poll: () => void;
  /** Emitted when the currently playing track changes */
  track: (payload: SeratoTrackPayload) => void;
  /** Emitted when new history entries are detected */
  history: (payload: SeratoHistoryPayload) => void;
  /** Emitted when a new session is detected */
  session: (payload: SeratoSessionPayload) => void;
  /** Emitted on errors */
  error: (err: Error) => void;
}

export type TypedEmitter = StrictEventEmitter<EventEmitter, SeratoConnectEvents>;

// ============================================================================
// GEOB Metadata Types
// ============================================================================

/**
 * RGB color with optional alpha channel.
 */
export interface SeratoColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/**
 * A cue point (hot cue) set in Serato.
 *
 * Cue points have indices 0-7 for hotcues.
 */
export interface SeratoCuePoint {
  /** Index of the cue point (0-7 for hotcues) */
  index: number;
  /** Position in milliseconds */
  position: number;
  /** Color of the cue point */
  color: SeratoColor;
  /** Optional name (up to 51 characters) */
  name?: string;
}

/**
 * A saved loop set in Serato.
 *
 * Loops have indices 0-7 for saved loops.
 */
export interface SeratoLoop {
  /** Index of the loop (0-7 for saved loops) */
  index: number;
  /** Start position in milliseconds */
  startPosition: number;
  /** End position in milliseconds */
  endPosition: number;
  /** Color of the loop (ARGB) */
  color: SeratoColor;
  /** Whether the loop is locked */
  locked: boolean;
  /** Optional name */
  name?: string;
}

/**
 * A flip recording action (jump or censor).
 */
export interface SeratoFlipAction {
  /** Action type: 'jump' or 'censor' */
  type: 'jump' | 'censor';
  /** Source position in seconds */
  sourcePosition: number;
  /** Target position in seconds */
  targetPosition: number;
  /** Speed factor (only for censor actions) */
  speedFactor?: number;
}

/**
 * A flip recording in Serato.
 */
export interface SeratoFlip {
  /** Index of the flip (0-5) */
  index: number;
  /** Whether the flip is enabled */
  enabled: boolean;
  /** Name of the flip */
  name: string;
  /** Whether the flip loops */
  loop: boolean;
  /** Actions in the flip */
  actions: SeratoFlipAction[];
}

/**
 * A beatgrid marker.
 *
 * The last marker is always a terminal marker with BPM.
 * Non-terminal markers have beat count to the next marker.
 */
export interface SeratoBeatgridMarker {
  /** Position in seconds */
  position: number;
  /** BPM value (only for terminal marker) */
  bpm?: number;
  /** Beat count to the next marker (non-terminal markers) */
  beatsToNext?: number;
}

/**
 * Beatgrid data for a track.
 */
export interface SeratoBeatgrid {
  /** Beatgrid markers */
  markers: SeratoBeatgridMarker[];
}

/**
 * Auto-analyzed tags for a track.
 */
export interface SeratoAutotags {
  /** Analyzed BPM */
  bpm: number;
  /** Auto gain value */
  autoGain: number;
  /** Gain in dB */
  gainDb: number;
}

/**
 * Complete parsed Markers2 data.
 */
export interface SeratoMarkers2 {
  /** Track color */
  trackColor?: SeratoColor;
  /** Whether the beatgrid is locked */
  bpmLock?: boolean;
  /** Cue points */
  cuePoints: SeratoCuePoint[];
  /** Saved loops */
  loops: SeratoLoop[];
  /** Flip recordings */
  flips: SeratoFlip[];
}

/**
 * Complete metadata from all GEOB frames.
 */
export interface SeratoTrackMetadata {
  /** Markers2 data (cues, loops, flips, color) */
  markers?: SeratoMarkers2;
  /** Beatgrid data */
  beatgrid?: SeratoBeatgrid;
  /** Autotags (analyzed BPM, gain) */
  autotags?: SeratoAutotags;
  /** Waveform overview data */
  overview?: Uint8Array;
}
