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

    this.deckTracks = new Array(NUM_REMOTE_DECKS + 1).fill(null);
    this.deckLoops = Array.from({ length: NUM_REMOTE_DECKS + 1 }, () => ({}));
    this.mixerState = {
      crossfader: undefined,
      upfaders: new Array(NUM_REMOTE_DECKS + 1).fill(undefined),
    };
  }

  private attachSession(session: RemoteSession): void {
    const peer = peerInfo(session.remotePeer);
    this.emit('peerConnected', peer);

    session.on('paired', () => this.emit('paired', peer));
    session.on('ping', () => this.emit('ping'));
    session.on('status', (msg) => this.handleStatus(msg));
    session.on('closed', () => this.emit('peerDisconnected', peer));
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
    this.emit('deckChange', { deckId, track: next, previousTrack: previous });
  }

  private ejectDeck(deckId: number): void {
    const previous = this.deckTracks[deckId];
    if (previous === null) return;
    this.deckTracks[deckId] = null;
    this.emit('deckChange', { deckId, track: null, previousTrack: previous });
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
  return { remoteAddress: p.remoteAddress, remotePort: p.remotePort };
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
