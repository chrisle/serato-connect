/**
 * @fileoverview SeratoRemoteClient — high-level facade for the OSC-over-TCP
 * Serato Remote protocol.
 *
 * Wires the {@link RemoteServer} (TCP + handshake) to the {@link publishSeratoRemote}
 * mDNS advert, maintains per-deck state from incoming `/Status/...` messages,
 * and emits drop-in-friendly events: `deckChange`, `playhead`, `loopChange`,
 * `mixerChange`.
 *
 * Status mapping reference: see ../docs/protocol.md.
 */

import EventEmitter from 'node:events';
import { type Logger, noopLogger } from '../types/logger.js';
import { type OscMessage } from './osc.js';
import { RemoteServer, type RemoteSession, type RemoteSessionPeer } from './server.js';
import { publishSeratoRemote, type MdnsPublication } from './mdns.js';
import {
  DEFAULT_SUBSCRIPTION_TOPICS,
  NUM_REMOTE_DECKS,
  type SeratoRemoteEmitter,
  type SeratoRemoteLoopState,
  type SeratoRemoteMixerState,
  type SeratoRemoteOptions,
  type SeratoRemotePeerInfo,
  type SeratoRemotePlayhead,
  type SeratoRemoteReadyInfo,
  type SeratoRemoteTrack,
} from './types.js';

const DEFAULT_PEER_NAME = 'serato-connect';
const DEFAULT_HOST = '0.0.0.0';

/**
 * How long a deck's track fields have to stay still before the track counts as
 * settled and `deckChange` fires.
 *
 * Serato does not send a track as one record: `/Status/Deck/Song/Title`,
 * `/Status/Deck/Song/Artist` and `/Status/Deck/Song/Filepath` arrive as
 * separate messages, back to back. Emitting on each one publishes a half-formed
 * track that pairs the NEW title with the PREVIOUS track's artist, and
 * downstream that impostor races the real track all the way to the overlay —
 * which is how an overlay ends up showing the right title beside the artist of
 * the track before last (NP3-378).
 *
 * The fields of one load land within microseconds of each other, so this only
 * has to outlast the gap between messages in a burst, not any human-visible
 * delay.
 */
const TRACK_SETTLE_MS = 50;

/**
 * High-level client. Publishes the Bonjour service, accepts inbound TCP
 * streams from Serato DJ Pro, drives the handshake, and surfaces
 * track/playhead/mixer/loop state as typed events.
 */
export class SeratoRemoteClient extends (EventEmitter as new () => SeratoRemoteEmitter) {
  private readonly options: Required<Omit<SeratoRemoteOptions, 'logger'>> & { logger: Logger };
  private server: RemoteServer | null = null;
  private mdns: MdnsPublication | null = null;

  /** Per-deck loaded track. Index = deck number (1-based). Index 0 unused. */
  private deckTracks: (SeratoRemoteTrack | null)[] = new Array(NUM_REMOTE_DECKS + 1).fill(null);
  /**
   * Per-deck track as of the last emitted `deckChange`. `deckTracks` moves with
   * every field message; this only moves when an event goes out, so it is what
   * `previousTrack` and the change comparison have to be measured against.
   */
  private emittedTracks: (SeratoRemoteTrack | null)[] = new Array(NUM_REMOTE_DECKS + 1).fill(null);
  /** Per-deck timer collecting a burst of field updates. Index = deckId. */
  private settleTimers: (ReturnType<typeof setTimeout> | null)[] = new Array(
    NUM_REMOTE_DECKS + 1,
  ).fill(null);
  /** Last loop state per deck (1-based index). */
  private deckLoops: SeratoRemoteLoopState[] = Array.from(
    { length: NUM_REMOTE_DECKS + 1 },
    () => ({}),
  );
  /** Last upfader value per deck (1-based index). */
  private mixerState: SeratoRemoteMixerState = {
    crossfader: undefined,
    upfaders: new Array(NUM_REMOTE_DECKS + 1).fill(undefined),
  };

  constructor(options: SeratoRemoteOptions = {}) {
    super();
    this.options = {
      peerName: options.peerName ?? DEFAULT_PEER_NAME,
      port: options.port ?? 0,
      host: options.host ?? DEFAULT_HOST,
      subscribeTopics: options.subscribeTopics ?? DEFAULT_SUBSCRIPTION_TOPICS,
      maxFrameBytes: options.maxFrameBytes ?? 1 << 20,
      logger: options.logger ?? noopLogger,
    };
  }

  /** Whether the client is currently advertising and accepting connections. */
  get running(): boolean {
    return this.server !== null;
  }

  /** Track currently loaded on the given 1-based deck, or null. */
  getDeckTrack(deckId: number): SeratoRemoteTrack | null {
    if (deckId < 1 || deckId > NUM_REMOTE_DECKS) return null;
    return this.deckTracks[deckId];
  }

  /** Last-observed loop state for the given 1-based deck. */
  getDeckLoop(deckId: number): SeratoRemoteLoopState {
    if (deckId < 1 || deckId > NUM_REMOTE_DECKS) return {};
    return { ...this.deckLoops[deckId] };
  }

  /** Last-observed mixer state. */
  getMixer(): SeratoRemoteMixerState {
    return {
      crossfader: this.mixerState.crossfader,
      upfaders: [...this.mixerState.upfaders],
    };
  }

  /** Start the TCP server and publish the Bonjour advert. */
  async start(): Promise<SeratoRemoteReadyInfo> {
    if (this.server) {
      throw new Error('SeratoRemoteClient already started');
    }

    const server = new RemoteServer({
      port: this.options.port,
      host: this.options.host,
      subscribeTopics: this.options.subscribeTopics,
      peerName: this.options.peerName,
      maxFrameBytes: this.options.maxFrameBytes,
      logger: this.options.logger,
    });
    server.on('error', (err) => this.emit('error', err));
    server.on('session', (session) => this.attachSession(session));

    const port = await server.start();
    this.server = server;

    let mdns: MdnsPublication;
    try {
      mdns = await publishSeratoRemote({
        peerName: this.options.peerName,
        port,
        logger: this.options.logger,
      });
    } catch (err) {
      // mDNS failed — tear the TCP server back down and surface the error.
      await server.stop();
      this.server = null;
      throw err;
    }
    this.mdns = mdns;

    const info: SeratoRemoteReadyInfo = {
      port,
      instanceName: mdns.instanceName,
    };
    this.emit('ready', info);
    return info;
  }

  /** Stop accepting connections, tear down the advert, reset deck state. */
  async stop(): Promise<void> {
    const server = this.server;
    const mdns = this.mdns;
    this.server = null;
    this.mdns = null;

    if (mdns) {
      try {
        await mdns.stop();
      } catch (err) {
        this.options.logger.warn('SeratoRemoteClient: mdns stop error', err);
      }
    }
    if (server) {
      try {
        await server.stop();
      } catch (err) {
        this.options.logger.warn('SeratoRemoteClient: server stop error', err);
      }
    }

    for (let deckId = 0; deckId <= NUM_REMOTE_DECKS; deckId++) {
      this.clearSettleTimer(deckId);
    }
    this.deckTracks = new Array(NUM_REMOTE_DECKS + 1).fill(null);
    this.emittedTracks = new Array(NUM_REMOTE_DECKS + 1).fill(null);
    this.deckLoops = Array.from({ length: NUM_REMOTE_DECKS + 1 }, () => ({}));
    this.mixerState = {
      crossfader: undefined,
      upfaders: new Array(NUM_REMOTE_DECKS + 1).fill(undefined),
    };
  }

  private attachSession(session: RemoteSession): void {
    this.emit('peerConnected', peerInfo(session.remotePeer));

    // Take the peer from each event rather than snapshotting it here: Serato's
    // own name only becomes known when it pairs, so `paired`/`peerDisconnected`
    // carry a richer peer than `peerConnected` did.
    session.on('paired', (peer) => this.emit('paired', peerInfo(peer)));
    session.on('ping', () => this.emit('ping'));
    session.on('closed', (peer) => this.emit('peerDisconnected', peerInfo(peer)));
    session.on('status', (msg) => this.handleStatus(msg));
    session.on('error', (err) => this.emit('error', err));
  }

  private handleStatus(msg: OscMessage): void {
    const { address, args } = msg;

    // Mixer-wide: crossfader has no deck index.
    if (address === '/Status/Video/Mixer/Crossfader') {
      const v = floatArg(args, 0);
      if (v == null) return;
      if (this.mixerState.crossfader === v) return;
      this.mixerState.crossfader = v;
      this.emit('mixerChange', { mixer: this.getMixer() });
      return;
    }

    // Everything else is per-deck; first arg is a deck index.
    const deckIndex = intArg(args, 0);
    if (deckIndex == null) return;
    const deckId = this.toDeckId(deckIndex);
    if (deckId == null) return;

    switch (address) {
      case '/Status/Deck/Song/Title':
        this.updateTrack(deckId, { title: stringArg(args, 1) ?? '' });
        return;
      case '/Status/Deck/Song/Artist':
        this.updateTrack(deckId, { artist: stringArg(args, 1) ?? '' });
        return;
      case '/Status/Deck/Song/Filepath':
        this.updateTrack(deckId, { filePath: stringArg(args, 1) ?? '' });
        return;
      case '/Status/Deck/Song/Valid': {
        const valid = boolArg(args, 1);
        this.updateTrack(deckId, { valid });
        if (valid === false) {
          this.ejectDeck(deckId);
        }
        return;
      }
      case '/Status/Deck/Playhead': {
        const a = floatArg(args, 1);
        const b = floatArg(args, 2);
        const c = floatArg(args, 3);
        if (a == null || b == null || c == null) return;
        const playhead: SeratoRemotePlayhead = {
          positionSeconds: a,
          playRate: b,
          bpm: c,
          raw: [a, b, c] as const,
        };
        this.emit('playhead', { deckId, playhead });
        return;
      }
      case '/Status/Deck/Loop/AutoLoopOn':
        this.updateLoop(deckId, { autoLoopOn: boolArg(args, 1) });
        return;
      case '/Status/Deck/Loop/BeatLength':
        this.updateLoop(deckId, { beatLength: floatArg(args, 1) });
        return;
      case '/Status/Deck/Loop/LoopRollOn':
        this.updateLoop(deckId, { loopRollOn: boolArg(args, 1) });
        return;
      case '/Status/Video/Deck/Mixer/Upfader': {
        const v = floatArg(args, 1);
        if (v == null) return;
        if (this.mixerState.upfaders[deckId] === v) return;
        const next = [...this.mixerState.upfaders];
        next[deckId] = v;
        this.mixerState = { ...this.mixerState, upfaders: next };
        this.emit('mixerChange', { mixer: this.getMixer() });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Convert a raw deck index from an OSC arg to a 1-based deckId. Accepts
   * both 0-based (most likely) and 1-based emitters by treating any value in
   * `[0..NUM-1]` as 0-based and `[1..NUM]` as 1-based; ambiguous values in
   * the overlap (1..NUM-1) are assumed 0-based and offset by 1.
   *
   * NOTE: indexing convention is unverified per protocol.md §6. Once a real
   * session pins it down, this can collapse to a straight `+1` or pass-through.
   */
  private toDeckId(raw: number): number | null {
    if (!Number.isFinite(raw)) return null;
    if (raw === NUM_REMOTE_DECKS) return NUM_REMOTE_DECKS; // last deck either way
    if (raw >= 0 && raw < NUM_REMOTE_DECKS) return raw + 1;
    if (raw >= 1 && raw <= NUM_REMOTE_DECKS) return raw;
    return null;
  }

  private updateTrack(deckId: number, patch: Partial<SeratoRemoteTrack>): void {
    const previous = this.deckTracks[deckId];
    const next: SeratoRemoteTrack = { ...(previous ?? {}), ...patch };
    if (tracksEqual(previous, next)) return;
    this.deckTracks[deckId] = next;
    // Restart the window on every field, so the whole burst for one load lands
    // in a single event no matter how many messages it takes.
    this.clearSettleTimer(deckId);
    this.settleTimers[deckId] = setTimeout(() => {
      this.settleTimers[deckId] = null;
      this.flushDeckChange(deckId);
    }, TRACK_SETTLE_MS);
  }

  private ejectDeck(deckId: number): void {
    // An eject is definitive — nothing more is coming for this track, so it
    // does not wait out the settle window.
    this.clearSettleTimer(deckId);
    if (this.deckTracks[deckId] === null && this.emittedTracks[deckId] === null) return;
    this.deckTracks[deckId] = null;
    this.flushDeckChange(deckId);
  }

  /** Emit the deck's settled track, if it differs from what was last emitted. */
  private flushDeckChange(deckId: number): void {
    const track = this.deckTracks[deckId];
    const previousTrack = this.emittedTracks[deckId];
    if (tracksEqual(previousTrack, track)) return;
    this.emittedTracks[deckId] = track;
    this.emit('deckChange', { deckId, track, previousTrack });
  }

  private clearSettleTimer(deckId: number): void {
    const pending = this.settleTimers[deckId];
    if (pending) clearTimeout(pending);
    this.settleTimers[deckId] = null;
  }

  private updateLoop(deckId: number, patch: Partial<SeratoRemoteLoopState>): void {
    const previous = this.deckLoops[deckId];
    const next: SeratoRemoteLoopState = { ...previous, ...patch };
    if (loopsEqual(previous, next)) return;
    this.deckLoops[deckId] = next;
    this.emit('loopChange', { deckId, loop: { ...next } });
  }
}

function peerInfo(p: RemoteSessionPeer): SeratoRemotePeerInfo {
  return {
    remoteAddress: p.remoteAddress,
    remotePort: p.remotePort,
    ...(p.name ? { peerName: p.name } : {}),
    ...(p.uuid ? { peerUuid: p.uuid } : {}),
  };
}

function intArg(args: OscMessage['args'], i: number): number | null {
  const a = args[i];
  if (!a) return null;
  if (a.type === 'i') return a.value;
  if (a.type === 'f') return Math.round(a.value);
  return null;
}

function floatArg(args: OscMessage['args'], i: number): number | null {
  const a = args[i];
  if (!a) return null;
  if (a.type === 'f') return a.value;
  if (a.type === 'i') return a.value;
  return null;
}

function stringArg(args: OscMessage['args'], i: number): string | null {
  const a = args[i];
  if (!a) return null;
  return a.type === 's' ? a.value : null;
}

/**
 * Convert a "boolean as float" arg (the protocol's convention — 1.0 / 0.0)
 * to a real boolean. Accepts int or float; treats anything ≥ 0.5 as true.
 */
function boolArg(args: OscMessage['args'], i: number): boolean | undefined {
  const v = floatArg(args, i);
  if (v == null) return undefined;
  return v >= 0.5;
}

function tracksEqual(a: SeratoRemoteTrack | null, b: SeratoRemoteTrack | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.title === b.title && a.artist === b.artist && a.filePath === b.filePath && a.valid === b.valid
  );
}

function loopsEqual(a: SeratoRemoteLoopState, b: SeratoRemoteLoopState): boolean {
  return (
    a.autoLoopOn === b.autoLoopOn && a.beatLength === b.beatLength && a.loopRollOn === b.loopRollOn
  );
}
