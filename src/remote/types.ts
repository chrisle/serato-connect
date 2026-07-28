/**
 * @fileoverview Public types for the Serato Remote OSC-over-TCP client.
 */

import EventEmitter from 'node:events';
import type { StrictEventEmitter } from 'strict-event-emitter-types';
import type { Logger } from '../types/logger.js';

/** Number of decks the protocol supports. */
export const NUM_REMOTE_DECKS = 4;

/**
 * Configuration for a {@link SeratoRemoteClient}.
 */
export interface SeratoRemoteOptions {
  /**
   * Display name advertised in the Bonjour instance name.
   * The full instance name becomes "<peerName> @ <hostname>".
   * Default: "serato-connect".
   */
  peerName?: string;

  /**
   * TCP port to listen on. Use 0 to let the OS assign a free port (recommended);
   * the actually-bound port will be reflected in the Bonjour SRV record.
   */
  port?: number;

  /**
   * Network interface to bind on (e.g. "0.0.0.0", "127.0.0.1").
   * Default: "0.0.0.0".
   */
  host?: string;

  /**
   * Topics to subscribe to on every accepted connection. If omitted, the
   * client subscribes to all known status topics.
   */
  subscribeTopics?: readonly string[];

  /**
   * Maximum allowed OSC frame size in bytes. Default: 1 MiB.
   */
  maxFrameBytes?: number;

  /**
   * Logger instance. If omitted, logging is disabled.
   */
  logger?: Logger;
}

/**
 * A track loaded on a Serato deck, as observed over the Remote protocol.
 *
 * Unlike the file-based history reader, the protocol exposes only a small
 * set of fields per track. Richer metadata (BPM, key, genre, GEOB tags,
 * etc.) must be looked up from the file system using `filePath`.
 */
export interface SeratoRemoteTrack {
  /** Track title (UTF-8). */
  title?: string;
  /** Track artist (UTF-8). */
  artist?: string;
  /** Absolute file path on the desktop machine. */
  filePath?: string;
  /** Whether the deck is currently loaded with a valid track. */
  valid?: boolean;
}

/**
 * Live playhead state for a deck.
 *
 * The three floats from `/Status/Deck/Playhead` are `(positionSeconds,
 * playRate, bpm)` — verified live against Serato DJ Pro 3.3.5.29 by sweeping
 * the pitch fader (`bpm / playRate` stays constant at the track's base BPM).
 * They are also exposed verbatim in {@link raw}.
 */
export interface SeratoRemotePlayhead {
  /** First float — playhead position in seconds. */
  positionSeconds?: number;
  /**
   * Second float — the current play rate: `0` when stopped/paused, `1.0` at
   * normal speed, and the pitch-fader multiplier when playing (e.g. `0.92` at
   * −8%). A non-zero value means the deck is playing.
   */
  playRate?: number;
  /** Third float — the current, pitch-adjusted BPM (`baseBpm × playRate`). */
  bpm?: number;
  /** All three floats verbatim: `[positionSeconds, playRate, bpm]`. */
  raw: readonly [number, number, number];
}

/** Active loop state for a deck. */
export interface SeratoRemoteLoopState {
  /** Auto-loop on/off. */
  autoLoopOn?: boolean;
  /** Active loop length in beats (e.g. 0.25, 0.5, 1, 2, 4, 8). */
  beatLength?: number;
  /** Loop-roll on/off. */
  loopRollOn?: boolean;
}

/** Mixer-wide state. */
export interface SeratoRemoteMixerState {
  /** Crossfader position (range unverified — typically -1..+1 or 0..1). */
  crossfader?: number;
  /** Per-deck channel fader positions (index 0 = deck 1). */
  upfaders: readonly (number | undefined)[];
}

/** Payload for the `deckChange` event. */
export interface SeratoRemoteDeckChangePayload {
  /** Deck number (1-based, matching the file-based reader). */
  deckId: number;
  /** Track now loaded on the deck, or null if the deck is empty. */
  track: SeratoRemoteTrack | null;
  /** Previous track on the deck, or null if it was empty. */
  previousTrack: SeratoRemoteTrack | null;
}

/** Payload for the `playhead` event. */
export interface SeratoRemotePlayheadPayload {
  /** Deck number (1-based). */
  deckId: number;
  /** Live playhead state. */
  playhead: SeratoRemotePlayhead;
}

/** Payload for the `loopChange` event. */
export interface SeratoRemoteLoopPayload {
  /** Deck number (1-based). */
  deckId: number;
  /** Current loop state for the deck. */
  loop: SeratoRemoteLoopState;
}

/** Payload for the `mixerChange` event. */
export interface SeratoRemoteMixerPayload {
  /** Current mixer state. */
  mixer: SeratoRemoteMixerState;
}

/** Information emitted when the client is up and advertising. */
export interface SeratoRemoteReadyInfo {
  /** TCP port the server is bound on. */
  port: number;
  /** Bonjour instance name actually published. */
  instanceName: string;
}

/** Information emitted when Serato connects (per stream). */
export interface SeratoRemotePeerInfo {
  /** Remote address of the connecting peer (Serato DJ Pro). */
  remoteAddress: string;
  /** Remote port of the connecting peer. */
  remotePort: number;
}

/** Events emitted by SeratoRemoteClient. */
export interface SeratoRemoteEvents {
  /** Emitted once the listener is bound and the Bonjour advert is up. */
  ready: (info: SeratoRemoteReadyInfo) => void;
  /** Emitted each time Serato opens a TCP stream (typically twice per session). */
  peerConnected: (info: SeratoRemotePeerInfo) => void;
  /** Emitted when a stream from Serato closes. */
  peerDisconnected: (info: SeratoRemotePeerInfo) => void;
  /** Emitted when the Authorize/Pair handshake on a stream completes. */
  paired: (info: SeratoRemotePeerInfo) => void;
  /** Emitted on track load/eject. */
  deckChange: (payload: SeratoRemoteDeckChangePayload) => void;
  /** Emitted on every playhead update — high frequency. */
  playhead: (payload: SeratoRemotePlayheadPayload) => void;
  /** Emitted when loop state changes. */
  loopChange: (payload: SeratoRemoteLoopPayload) => void;
  /** Emitted when mixer state changes (crossfader or any upfader). */
  mixerChange: (payload: SeratoRemoteMixerPayload) => void;
  /** Emitted when a heartbeat exchange completes. */
  ping: () => void;
  /** Emitted on any non-fatal error (parse, framing, peer). */
  error: (err: Error) => void;
}

export type SeratoRemoteEmitter = StrictEventEmitter<EventEmitter, SeratoRemoteEvents>;

/** Default subscription set covering all currently-known status topics. */
export const DEFAULT_SUBSCRIPTION_TOPICS: readonly string[] = [
  '/Register/Status/Deck/Playhead',
  '/Register/Status/Deck/Song/Title',
  '/Register/Status/Deck/Song/Artist',
  '/Register/Status/Deck/Song/Filepath',
  '/Register/Status/Deck/Song/Valid',
  '/Register/Status/Deck/Loop/AutoLoopOn',
  '/Register/Status/Deck/Loop/BeatLength',
  '/Register/Status/Deck/Loop/LoopRollOn',
  '/Register/Status/Video/Deck/Mixer/Upfader',
  '/Register/Status/Video/Mixer/Crossfader',
];
