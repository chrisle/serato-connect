/**
 * Loopback tests for RemoteSession + SeratoRemoteClient handshake/dispatch.
 *
 * Uses real localhost TCP sockets to drive RemoteSession through its
 * Authorize/Pair/Subscribe/Ping flow without touching mDNS.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { RemoteSession } from '../../src/remote/server.js';
import { FrameReader, frameOsc } from '../../src/remote/framing.js';
import { osc, arg, type OscMessage } from '../../src/remote/osc.js';
import { SeratoRemoteClient } from '../../src/remote/client.js';
import type {
  SeratoRemoteDeckChangePayload,
  SeratoRemotePlayheadPayload,
} from '../../src/remote/types.js';

interface Loopback {
  serverSocket: Socket;
  clientSocket: Socket;
  cleanup: () => Promise<void>;
}

async function loopback(): Promise<Loopback> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');

  const accepted = once(server, 'connection') as Promise<[Socket]>;
  const clientSocket = connect(addr.port, '127.0.0.1');
  await once(clientSocket, 'connect');
  const [serverSocket] = await accepted;

  return {
    serverSocket,
    clientSocket,
    async cleanup() {
      clientSocket.destroy();
      serverSocket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Collect frames arriving on `socket` for `ms` milliseconds. */
async function collect(socket: Socket, ms: number): Promise<OscMessage[]> {
  const reader = new FrameReader();
  const out: OscMessage[] = [];
  const onData = (chunk: Buffer) => {
    for (const msg of reader.push(chunk)) {
      out.push(msg);
    }
  };
  socket.on('data', onData);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  socket.off('data', onData);
  return out;
}

describe('RemoteSession handshake', () => {
  let cleanup: Loopback['cleanup'] | null = null;
  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('answers Authorize/Request with MD5(nonce ‖ secret) as ,ssb', async () => {
    const lb = await loopback();
    cleanup = lb.cleanup;
    new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });

    // The 16-byte challenge nonce Serato sends in Authorize/Request.
    const nonce = Buffer.from('3f47500e7d40141e774a9b908ef6bec0', 'hex');
    // One of the two secrets hardcoded in the Serato binary.
    const secret = Buffer.from(
      'd25db261a4411bc1f3788f57723b8977c541a4b619b94a9a8b45c46f8511c2f8',
      'hex',
    );
    const expected = createHash('md5').update(nonce).update(secret).digest();

    lb.clientSocket.write(
      frameOsc(osc('/StreamMgmt/Authorize/Request', arg.b(nonce), arg.i(1), arg.i(1))),
    );
    const replies = await collect(lb.clientSocket, 50);
    const resp = replies.find((m) => m.address === '/StreamMgmt/Authorize/Response');
    expect(resp).toBeDefined();
    // Shape: (peerName: s, peerUuid: s, digest: b)
    expect(resp!.args.map((a) => a.type)).toEqual(['s', 's', 'b']);
    const blob = resp!.args[2] as { type: 'b'; value: Buffer };
    expect(blob.value.equals(expected)).toBe(true);
  });

  it('on Pair, replies with an active Pair and sends subscribe topics', async () => {
    const lb = await loopback();
    cleanup = lb.cleanup;
    const topics = ['/Register/Status/Deck/Playhead', '/Register/Status/Deck/Song/Title'];
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: topics,
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });

    const pairedPromise = once(session, 'paired');
    lb.clientSocket.write(
      frameOsc(osc('/StreamMgmt/Pairing/Pair', arg.s('Serato'), arg.s('Serato DJ'), arg.i(0))),
    );
    const replies = await collect(lb.clientSocket, 100);
    await pairedPromise;

    const pairReply = replies.find((m) => m.address === '/StreamMgmt/Pairing/Pair');
    expect(pairReply).toBeDefined();
    // We activate the pairing with isActive=1.
    expect(pairReply!.args.map((a) => a.type)).toEqual(['s', 's', 'i']);
    expect((pairReply!.args[2] as { type: 'i'; value: number }).value).toBe(1);

    const addresses = replies.map((m) => m.address);
    for (const topic of topics) {
      expect(addresses).toContain(topic);
    }
    expect(session.paired).toBe(true);
  });

  it('records the name Serato pairs with on the peer', async () => {
    const lb = await loopback();
    cleanup = lb.cleanup;
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });

    expect(session.remotePeer.name).toBeUndefined();

    const pairedPromise = once(session, 'paired') as Promise<[{ name?: string; uuid?: string }]>;
    lb.clientSocket.write(
      frameOsc(
        osc('/StreamMgmt/Pairing/Pair', arg.s('SDJ @ studio-mac'), arg.s('Serato DJ'), arg.i(0)),
      ),
    );
    const [peer] = await pairedPromise;

    expect(peer.name).toBe('SDJ @ studio-mac');
    expect(peer.uuid).toBe('Serato DJ');
    expect(session.remotePeer.name).toBe('SDJ @ studio-mac');
  });

  it('echoes /Ping and emits a ping event', async () => {
    const lb = await loopback();
    cleanup = lb.cleanup;
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });

    const pingEvent = once(session, 'ping');
    lb.clientSocket.write(frameOsc(osc('/Ping')));
    const replies = await collect(lb.clientSocket, 50);
    await pingEvent;
    expect(replies.map((m) => m.address)).toContain('/Ping');
  });

  it('forwards /Status/* messages as status events', async () => {
    const lb = await loopback();
    cleanup = lb.cleanup;
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });

    const statusPromise = once(session, 'status') as Promise<[OscMessage]>;
    lb.clientSocket.write(frameOsc(osc('/Status/Deck/Song/Title', arg.i(0), arg.s('Hello'))));
    const [msg] = await statusPromise;
    expect(msg.address).toBe('/Status/Deck/Song/Title');
    expect(msg.args[1]).toEqual({ type: 's', value: 'Hello' });
  });
});

describe('SeratoRemoteClient status dispatch', () => {
  // The client is deck-state-aware; we exercise it directly by piping OSC
  // bytes through a RemoteSession into a client whose mDNS/server isn't
  // started. We attach a session manually via the private path: easier to
  // just instantiate a session and forward events through the public API.

  it('emits deckChange when title/artist/filepath converge for a deck', async () => {
    const lb = await loopback();
    const client = new SeratoRemoteClient();
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });

    // Bridge session events into the client via its private dispatch.
    // The exposed `attachSession` is private; reach in via a typed cast.
    type WithAttach = SeratoRemoteClient & {
      attachSession(s: RemoteSession): void;
    };
    (client as WithAttach).attachSession(session);

    const events: SeratoRemoteDeckChangePayload[] = [];
    client.on('deckChange', (p) => events.push(p));

    // deck index 0 → expect deckId 1
    lb.clientSocket.write(frameOsc(osc('/Status/Deck/Song/Title', arg.i(0), arg.s('T'))));
    lb.clientSocket.write(frameOsc(osc('/Status/Deck/Song/Artist', arg.i(0), arg.s('A'))));
    lb.clientSocket.write(
      frameOsc(osc('/Status/Deck/Song/Filepath', arg.i(0), arg.s('/tmp/x.mp3'))),
    );
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last.deckId).toBe(1);
    expect(last.track?.title).toBe('T');
    expect(last.track?.artist).toBe('A');
    expect(last.track?.filePath).toBe('/tmp/x.mp3');

    await lb.cleanup();
  });

  it('emits playhead with position, playRate, and bpm', async () => {
    const lb = await loopback();
    const client = new SeratoRemoteClient();
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });
    type WithAttach = SeratoRemoteClient & {
      attachSession(s: RemoteSession): void;
    };
    (client as WithAttach).attachSession(session);

    const events: SeratoRemotePlayheadPayload[] = [];
    client.on('playhead', (p) => events.push(p));

    // (positionSeconds=10s, playRate=0.92 → −8% pitch, bpm=114.08 effective)
    lb.clientSocket.write(
      frameOsc(osc('/Status/Deck/Playhead', arg.i(0), arg.f(10), arg.f(0.92), arg.f(114.08))),
    );
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0].deckId).toBe(1);
    expect(events[0].playhead.raw[0]).toBeCloseTo(10, 5);
    expect(events[0].playhead.raw[1]).toBeCloseTo(0.92, 5);
    expect(events[0].playhead.raw[2]).toBeCloseTo(114.08, 5);
    expect(events[0].playhead.positionSeconds).toBeCloseTo(10, 5);
    expect(events[0].playhead.playRate).toBeCloseTo(0.92, 5);
    expect(events[0].playhead.bpm).toBeCloseTo(114.08, 5);

    await lb.cleanup();
  });

  it('emits mixerChange for crossfader and per-deck upfaders', async () => {
    const lb = await loopback();
    const client = new SeratoRemoteClient();
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });
    type WithAttach = SeratoRemoteClient & {
      attachSession(s: RemoteSession): void;
    };
    (client as WithAttach).attachSession(session);

    let cfChanges = 0;
    let upChanges = 0;
    client.on('mixerChange', ({ mixer }) => {
      if (mixer.crossfader !== undefined && cfChanges === 0) cfChanges++;
      if (mixer.upfaders[1] !== undefined) upChanges++;
    });

    lb.clientSocket.write(frameOsc(osc('/Status/Video/Mixer/Crossfader', arg.f(0.25))));
    lb.clientSocket.write(frameOsc(osc('/Status/Video/Deck/Mixer/Upfader', arg.i(0), arg.f(0.8))));
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(cfChanges).toBe(1);
    expect(upChanges).toBeGreaterThanOrEqual(1);
    expect(client.getMixer().crossfader).toBeCloseTo(0.25, 5);
    expect(client.getMixer().upfaders[1]).toBeCloseTo(0.8, 5);

    await lb.cleanup();
  });

  it('ejects deck on Valid=0', async () => {
    const lb = await loopback();
    const client = new SeratoRemoteClient();
    const session = new RemoteSession({
      socket: lb.serverSocket,
      subscribeTopics: [],
      peerName: 'Test Peer',
      peerUuid: 'test-uuid',
    });
    type WithAttach = SeratoRemoteClient & {
      attachSession(s: RemoteSession): void;
    };
    (client as WithAttach).attachSession(session);

    const events: SeratoRemoteDeckChangePayload[] = [];
    client.on('deckChange', (p) => events.push(p));

    lb.clientSocket.write(frameOsc(osc('/Status/Deck/Song/Title', arg.i(0), arg.s('T'))));
    await new Promise<void>((r) => setTimeout(r, 25));
    lb.clientSocket.write(frameOsc(osc('/Status/Deck/Song/Valid', arg.i(0), arg.f(0))));
    await new Promise<void>((r) => setTimeout(r, 25));

    const ejected = events.find((e) => e.track === null);
    expect(ejected).toBeDefined();
    expect(ejected!.deckId).toBe(1);
    expect(client.getDeckTrack(1)).toBeNull();

    await lb.cleanup();
  });
});
