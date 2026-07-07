#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Capture Serato Remote OSC traffic for protocol verification.
 *
 * Runs the Bonjour publisher + TCP server, then logs everything Serato
 * sends/receives:
 *   - Raw bytes (hex dump, per connection)
 *   - Parsed OSC messages with type tags and arg values
 *   - Timing (relative to handshake start)
 *   - Outbound bytes we send back
 *
 * Output is written to stdout and to ./capture.log so it can be diffed
 * across runs.
 *
 * Usage:
 *   npm run build
 *   node scripts/capture-handshake.js
 *   # then launch Serato DJ Pro on the same machine
 */

const { createServer } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { hostname } = require('node:os');

const dist = path.join(__dirname, '..', 'dist');
const remote = require(path.join(dist, 'remote', 'index.js'));
const { decodeOsc, frameOsc, FrameReader, osc, arg, publishSeratoRemote } = remote;

const PORT = parseInt(process.env.SERATO_REMOTE_PORT || '0', 10);
const PEER_NAME = process.env.SERATO_REMOTE_PEER || 'serato-capture';
const LOG_PATH = process.env.LOG_PATH || path.join(__dirname, '..', 'capture.log');
const RUN_BUDGET_MS = parseInt(process.env.RUN_BUDGET_MS || '0', 10);

const startedAt = process.hrtime.bigint();
const logFile = fs.createWriteStream(LOG_PATH, { flags: 'w' });

function ts() {
  const ns = process.hrtime.bigint() - startedAt;
  return (Number(ns) / 1e6).toFixed(3).padStart(10, ' ');
}

function log(line) {
  const out = `[${ts()}ms] ${line}`;
  console.log(out);
  logFile.write(out + '\n');
}

function hex(buf) {
  const s = Buffer.from(buf).toString('hex');
  return s.length === 0 ? '' : s.match(/.{1,2}/g).join(' ');
}

function fmtMessage(msg) {
  const args = msg.args
    .map((a) => {
      if (a.type === 'i') return `i:${a.value}`;
      if (a.type === 'f') return `f:${a.value.toFixed(6)}`;
      if (a.type === 's') return `s:${JSON.stringify(a.value)}`;
      return `?`;
    })
    .join(' ');
  return `${msg.address}  [${args || '(no args)'}]`;
}

let connId = 0;
const conns = new Map(); // connId -> { reader, paired, peer }

const server = createServer((socket) => {
  const id = ++connId;
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`CONN#${id} OPEN from ${peer}`);
  const reader = new FrameReader(1 << 20);
  conns.set(id, { reader, paired: false, peer });

  socket.on('data', (chunk) => {
    log(`CONN#${id} <- raw ${chunk.length}B  ${hex(chunk)}`);
    let messages;
    try {
      messages = reader.push(chunk);
    } catch (err) {
      log(`CONN#${id} !! framing error: ${err.message}`);
      socket.destroy();
      return;
    }
    for (const msg of messages) {
      log(`CONN#${id} <- OSC  ${fmtMessage(msg)}`);
      handle(id, socket, msg);
    }
  });
  socket.on('close', () => log(`CONN#${id} CLOSE`));
  socket.on('error', (err) => log(`CONN#${id} ERR ${err.message}`));
});

function send(id, socket, msg) {
  const buf = frameOsc(msg);
  log(`CONN#${id} -> raw ${buf.length}B  ${hex(buf)}`);
  log(`CONN#${id} -> OSC  ${fmtMessage(msg)}`);
  socket.write(buf);
}

// Strategy mode (env-overridable so we can compare hypotheses without code edits):
//   STRATEGY=mirror_then_pair    → Authorize/Response = ,bii echo (1,1) + proactively send Pair (default)
//   STRATEGY=mirror_only         → Authorize/Response = ,bii echo (1,1), then wait for Serato to send Pair
//   STRATEGY=argless_only        → Authorize/Response = (no args), then wait
//   STRATEGY=mirror_then_status  → Authorize/Response = ,bii echo (1,1), then send StatusChanged("Paired")
//   STRATEGY=zeros_then_pair     → Authorize/Response = ,bii echo with (0,0) + send Pair (tests "0=ok" hypothesis)
//   STRATEGY=mirror_uuid_pair    → mirror_then_pair, but Pair uses a proper UUID for peerUUID
//   STRATEGY=mirror_only_long    → mirror_only with a 30 s patience window before bailing
//   STRATEGY=iib_then_pair       → Authorize/Response = ,iib (1,1,blob) + send Pair — matches Frida-disassembled handler at 0xb78cfc
//   STRATEGY=iib_only            → Authorize/Response = ,iib (1,1,blob), then wait
const STRATEGY = process.env.STRATEGY || 'mirror_then_pair';
const PEER_UUID = process.env.PEER_UUID || 'np-mac-1';

// FRIDA_DELAY_MS: pause this many ms after receiving Authorize/Request before replying.
// Useful when frida attaches AFTER Serato has already connected — the handler hooks
// won't have fired yet because the message is processed before they're installed.
const FRIDA_DELAY_MS = parseInt(process.env.FRIDA_DELAY_MS || '0', 10);

function respondToAuthorize(id, socket, blobArg) {
  if (STRATEGY === 'argless_only') {
    send(id, socket, osc('/StreamMgmt/Authorize/Response'));
    return;
  }
  if (!blobArg) {
    log(`CONN#${id} !! Authorize/Request had no blob — falling back to argless`);
    send(id, socket, osc('/StreamMgmt/Authorize/Response'));
    return;
  }
  const [i1, i2] = STRATEGY === 'zeros_then_pair' ? [0, 0] : [1, 1];
  if (STRATEGY === 'iib_then_pair' || STRATEGY === 'iib_only') {
    send(
      id,
      socket,
      osc('/StreamMgmt/Authorize/Response', arg.i(i1), arg.i(i2), arg.b(blobArg.value)),
    );
  } else {
    send(
      id,
      socket,
      osc('/StreamMgmt/Authorize/Response', arg.b(blobArg.value), arg.i(i1), arg.i(i2)),
    );
  }
  const sendPair = () =>
    send(
      id,
      socket,
      osc('/StreamMgmt/Pairing/Pair', arg.s('Now Playing'), arg.s(PEER_UUID), arg.i(1)),
    );
  if (
    STRATEGY === 'mirror_then_pair' ||
    STRATEGY === 'zeros_then_pair' ||
    STRATEGY === 'mirror_uuid_pair' ||
    STRATEGY === 'iib_then_pair'
  ) {
    setTimeout(sendPair, 50);
  } else if (STRATEGY === 'mirror_then_status') {
    setTimeout(() => {
      send(id, socket, osc('/StreamMgmt/Pairing/StatusChanged', arg.s('Paired')));
    }, 50);
  }
}

function handle(id, socket, msg) {
  const a = msg.address;
  if (a === '/StreamMgmt/Authorize/Request') {
    const blobArg = msg.args.find((x) => x.type === 'b');
    log(`CONN#${id} STRATEGY=${STRATEGY} PEER_UUID=${PEER_UUID} responding to Authorize/Request (delay=${FRIDA_DELAY_MS}ms)`);
    const respond = () => respondToAuthorize(id, socket, blobArg);
    if (FRIDA_DELAY_MS > 0) setTimeout(respond, FRIDA_DELAY_MS);
    else respond();
    return;
  }
  if (a === '/StreamMgmt/Pairing/Pair') {
    log(`CONN#${id} Serato sent Pair: ${msg.args.map((x) => `${x.type}:${x.value}`).join(' ')}`);
    send(id, socket, osc('/StreamMgmt/Pairing/StatusChanged', arg.s('Paired')));
    return;
  }
  if (a === '/StreamMgmt/Pairing/StatusChanged') {
    log(`CONN#${id} Serato confirmed pairing: ${msg.args.map((x) => `${x.type}:${x.value}`).join(' ')}`);
    if (!conns.get(id).paired) {
      conns.get(id).paired = true;
      const topics = [
        '/Register/Status/Deck/Playhead',
        '/Register/Status/Deck/Song/Title',
        '/Register/Status/Deck/Song/Artist',
        '/Register/Status/Deck/Song/Filepath',
        '/Register/Status/Deck/Song/Valid',
        '/Register/Status/Deck/Loop/AutoLoopOn',
        '/Register/Status/Deck/Loop/BeatLength',
        '/Register/Status/Deck/Loop/LoopRollOn',
        '/Register/Status/Deck/Loop/LoopInOutPoint',
        '/Register/Status/Deck/Loop/ManualLoopIn',
        '/Register/Status/Deck/Loop/ManualLoopOn',
        '/Register/Status/Deck/Loop/ManualLoopOut',
        '/Register/Status/Deck/Loop/ManualLoopSetting',
        '/Register/Status/Deck/Slicer/Loop',
        '/Register/Status/Video/Deck/Mixer/Upfader',
        '/Register/Status/Video/Mixer/Crossfader',
      ];
      for (const t of topics) send(id, socket, osc(t));
    }
    return;
  }
  if (a === '/Ping') {
    send(id, socket, osc('/Ping'));
    return;
  }
  // Unknown path — log it explicitly so we can identify drift.
  log(`CONN#${id} !! unhandled OSC address: ${a}`);
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(PORT, '0.0.0.0');
  });
  const addr = server.address();
  const port = addr.port;
  log(`SERVER LISTENING on 0.0.0.0:${port}`);

  const mdns = await publishSeratoRemote({
    peerName: PEER_NAME,
    port,
    logger: { trace() {}, debug() {}, info: log, warn: log, error: log },
  });
  log(`MDNS PUBLISHED instance=${JSON.stringify(mdns.instanceName)} port=${port} hostname=${hostname()}`);
  log('--- WAITING FOR SERATO TO CONNECT ---');

  const shutdown = async () => {
    log('SHUTDOWN');
    await mdns.stop().catch(() => {});
    server.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (RUN_BUDGET_MS > 0) {
    setTimeout(() => {
      log(`RUN_BUDGET_MS=${RUN_BUDGET_MS} reached — auto-shutdown`);
      shutdown();
    }, RUN_BUDGET_MS);
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
