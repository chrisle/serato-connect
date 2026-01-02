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
