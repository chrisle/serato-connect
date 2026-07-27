/**
 * @fileoverview Per-connection OSC session and the listening TCP server.
 *
 * Serato DJ Pro is the TCP **client** — it browses for our advert, then
 * opens (typically two) parallel TCP connections to us. Each connection
 * carries its own OSC stream. {@link RemoteSession} handles one such stream:
 * runs the handshake, sends subscription requests, replies to pings, and
 * emits parsed `/Status/...` messages outward via `onStatus`.
 *
 * {@link RemoteServer} owns the listening socket and instantiates a session
 * per accepted connection.
 */

import EventEmitter from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { StrictEventEmitter } from 'strict-event-emitter-types';
import type { Logger } from '../types/logger.js';
import { noopLogger } from '../types/logger.js';
import { FrameReader, frameOsc } from './framing.js';
import { type OscMessage, osc, arg } from './osc.js';

/**
 * Shared secret Serato DJ Pro uses to authenticate Remote peers. The
 * `/StreamMgmt/Authorize/Response` must carry `MD5(nonce ‖ secret)` where
 * `nonce` is the 16-byte blob from `/StreamMgmt/Authorize/Request`. Two such
 * secrets are hardcoded in the Serato binary (either is accepted); this is
 * one of them. See ../../docs/protocol.md §3.1.1.
 */
const SERATO_REMOTE_SECRET = Buffer.from(
  'd25db261a4411bc1f3788f57723b8977c541a4b619b94a9a8b45c46f8511c2f8',
  'hex',
);

/**
 * Reasonably high default for the unverified frame max — large enough for
 * any plausible OSC payload (track strings, etc.) without being so large
 * that a malformed length prefix can DoS us.
 */
const DEFAULT_MAX_FRAME_BYTES = 1 << 20;

export interface RemoteSessionPeer {
  remoteAddress: string;
  remotePort: number;
}

export interface RemoteSessionOptions {
  socket: Socket;
  /** OSC paths to subscribe to once paired. */
  subscribeTopics: readonly string[];
  /** Human-readable peer name advertised to Serato during the handshake. */
  peerName: string;
  /** Stable UUID identifying this peer to Serato. */
  peerUuid: string;
  /** Maximum allowed frame size. */
  maxFrameBytes?: number;
  /** Pluggable logger. */
  logger?: Logger;
}

/**
 * Lightweight typed event payloads for a single session. The high-level
 * client subscribes to these; the server forwards them as-is.
 */
export interface RemoteSessionEvents {
  paired: (peer: RemoteSessionPeer) => void;
  status: (msg: OscMessage, peer: RemoteSessionPeer) => void;
  ping: (peer: RemoteSessionPeer) => void;
  closed: (peer: RemoteSessionPeer) => void;
  error: (err: Error, peer: RemoteSessionPeer) => void;
}

type SessionEmitter = StrictEventEmitter<EventEmitter, RemoteSessionEvents>;

/**
 * One accepted TCP connection from Serato. Drives the handshake and
 * subscription, emits parsed status messages.
 */
export class RemoteSession extends (EventEmitter as new () => SessionEmitter) {
  private readonly socket: Socket;
  private readonly reader: FrameReader;
  private readonly subscribeTopics: readonly string[];
  private readonly peerName: string;
  private readonly peerUuid: string;
  private readonly logger: Logger;
  private readonly peer: RemoteSessionPeer;
  private isPaired = false;
  private isSubscribed = false;
  private isClosed = false;

  constructor(opts: RemoteSessionOptions) {
    super();
    this.socket = opts.socket;
    this.subscribeTopics = opts.subscribeTopics;
    this.peerName = opts.peerName;
    this.peerUuid = opts.peerUuid;
    this.logger = opts.logger ?? noopLogger;
    this.reader = new FrameReader(opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.peer = {
      remoteAddress: opts.socket.remoteAddress ?? 'unknown',
      remotePort: opts.socket.remotePort ?? 0,
    };

    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('close', () => this.handleClose());
    this.socket.on('error', (err) => this.handleSocketError(err));
  }

  /** Address of the connected peer. */
  get remotePeer(): RemoteSessionPeer {
    return this.peer;
  }

  /** Whether the Authorize/Pair handshake has completed. */
  get paired(): boolean {
    return this.isPaired;
  }

  /** Send an OSC message immediately (if the socket is still writable). */
  send(msg: OscMessage): void {
    if (this.isClosed || this.socket.destroyed) {
      return;
    }
    try {
      this.socket.write(frameOsc(msg));
    } catch (err) {
      this.emit('error', toError(err), this.peer);
    }
  }

  /** Cleanly tear down the session: send unpair, end the socket. */
  close(): void {
    if (this.isClosed) return;
    if (this.isPaired) {
      this.send(osc('/StreamMgmt/Pairing/UnPair'));
    }
    this.isClosed = true;
    try {
      this.socket.end();
    } catch (err) {
      this.logger.warn('remote session: error ending socket', err);
    }
  }

  private handleData(chunk: Buffer): void {
    if (this.isClosed) return;
    let messages: OscMessage[];
    try {
      messages = this.reader.push(chunk);
    } catch (err) {
      this.emit('error', toError(err), this.peer);
      this.socket.destroy();
      return;
    }
    for (const msg of messages) {
      this.dispatch(msg);
    }
  }

  private dispatch(msg: OscMessage): void {
    const { address } = msg;

    if (address === '/StreamMgmt/Authorize/Request') {
      // Serato sends a 16-byte challenge nonce. Prove we know the shared
      // secret by replying with (peerName, peerUuid, MD5(nonce ‖ secret)) —
      // type tag `,ssb`. A wrong/absent digest makes Serato go silent.
      const nonce = msg.args.find((a) => a.type === 'b')?.value;
      if (!nonce) {
        this.logger.warn('remote session: Authorize/Request had no nonce blob');
        return;
      }
      const digest = createHash('md5').update(nonce).update(SERATO_REMOTE_SECRET).digest();
      this.send(
        osc(
          '/StreamMgmt/Authorize/Response',
          arg.s(this.peerName),
          arg.s(this.peerUuid),
          arg.b(digest),
        ),
      );
      return;
    }
    if (address === '/StreamMgmt/Pairing/Pair') {
      // After authorizing, Serato sends its own Pair (with isActive=0). Reply
      // with our Pair marked active (isActive=1) to open the status stream,
      // then subscribe to the topics we care about.
      this.send(
        osc('/StreamMgmt/Pairing/Pair', arg.s(this.peerName), arg.s(this.peerUuid), arg.i(1)),
      );
      this.subscribe();
      if (!this.isPaired) {
        this.isPaired = true;
        this.emit('paired', this.peer);
      }
      return;
    }
    if (address === '/StreamMgmt/Pairing/StatusChanged') {
      // A pairing-state notification from Serato — ensure we've subscribed.
      this.subscribe();
      return;
    }
    if (address === '/StreamMgmt/Pairing/UnPair') {
      this.isPaired = false;
      try {
        this.socket.end();
      } catch {
        // best-effort
      }
      return;
    }
    if (address === '/Ping') {
      // Echo the ping back. Some implementations expect the echo, others
      // treat it as a one-way liveness indicator — echoing is safe.
      this.send(osc('/Ping'));
      this.emit('ping', this.peer);
      return;
    }

    if (address.startsWith('/Status/')) {
      this.emit('status', msg, this.peer);
      return;
    }

    // Unknown path — log at debug and keep the stream alive.
    this.logger.debug('remote session: ignoring unknown OSC path %s', address);
  }

  /** Send one `/Register/Status/<topic>` per subscribed topic, once. */
  private subscribe(): void {
    if (this.isSubscribed) return;
    this.isSubscribed = true;
    for (const topic of this.subscribeTopics) {
      this.send(osc(topic));
    }
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('closed', this.peer);
  }

  private handleSocketError(err: Error): void {
    this.emit('error', err, this.peer);
  }
}

export interface RemoteServerOptions {
  port: number;
  host: string;
  subscribeTopics: readonly string[];
  /** Human-readable peer name advertised to Serato during the handshake. */
  peerName: string;
  /** Stable UUID identifying this peer to Serato (generated if omitted). */
  peerUuid?: string;
  maxFrameBytes?: number;
  logger?: Logger;
}

/** Hooks exposed by RemoteServer. The high-level client wires into these. */
export interface RemoteServerEvents {
  listening: (info: { port: number; host: string }) => void;
  session: (session: RemoteSession) => void;
  error: (err: Error) => void;
}

type ServerEmitter = StrictEventEmitter<EventEmitter, RemoteServerEvents>;

/**
 * TCP listener that accepts Serato's inbound connections (typically two in
 * parallel) and emits a {@link RemoteSession} for each.
 */
export class RemoteServer extends (EventEmitter as new () => ServerEmitter) {
  private readonly tcp: Server;
  private readonly options: RemoteServerOptions;
  private readonly peerUuid: string;
  private readonly logger: Logger;
  private readonly sessions = new Set<RemoteSession>();
  private boundPort: number | null = null;

  constructor(opts: RemoteServerOptions) {
    super();
    this.options = opts;
    // A stable UUID for the lifetime of the server, shared across the two
    // parallel connections Serato opens.
    this.peerUuid = opts.peerUuid ?? randomUUID();
    this.logger = opts.logger ?? noopLogger;
    this.tcp = createServer((socket) => this.handleConnection(socket));
    this.tcp.on('error', (err) => this.emit('error', err));
  }

  /** Resolved port — meaningful only after `start()` resolves. */
  get port(): number {
    if (this.boundPort == null) {
      throw new Error('RemoteServer not started');
    }
    return this.boundPort;
  }

  /** Start listening; resolves with the actually-bound port. */
  async start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        this.tcp.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.tcp.removeListener('error', onError);
        const addr = this.tcp.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error(`Unexpected listening address: ${String(addr)}`));
          return;
        }
        this.boundPort = addr.port;
        this.emit('listening', { port: addr.port, host: this.options.host });
        resolve(addr.port);
      };
      this.tcp.once('error', onError);
      this.tcp.once('listening', onListening);
      this.tcp.listen(this.options.port, this.options.host);
    });
  }

  /** Stop accepting new connections and close all in-flight sessions. */
  async stop(): Promise<void> {
    for (const session of this.sessions) {
      session.close();
    }
    this.sessions.clear();
    return new Promise<void>((resolve) => {
      this.tcp.close(() => resolve());
      // close() only fires after every connection drains. Force-detach any
      // straggling connections after a short grace period.
      setTimeout(() => {
        this.tcp.unref?.();
        resolve();
      }, 250).unref?.();
    });
  }

  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    const session = new RemoteSession({
      socket,
      subscribeTopics: this.options.subscribeTopics,
      peerName: this.options.peerName,
      peerUuid: this.peerUuid,
      maxFrameBytes: this.options.maxFrameBytes,
      logger: this.logger,
    });
    this.sessions.add(session);
    session.on('closed', () => this.sessions.delete(session));
    this.emit('session', session);
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
