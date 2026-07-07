#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Capture Serato Remote OSC traffic — RAW PASSIVE MODE.
 *
 * Unlike capture-handshake.js, this does NOT try to parse or frame any
 * incoming data. It just publishes the Bonjour service, accepts connections,
 * and dumps every byte chunk it sees to capture-raw.log.
 *
 * It also tries multiple response strategies on each new connection so we
 * can see what Serato is actually sending. The strategies are:
 *  - Strategy A: respond to NOTHING, just observe
 *
 * (Other strategies can be added once we understand the framing.)
 *
 * Usage:
 *   npm run build
 *   node scripts/capture-raw.js
 *   # then launch Serato DJ Pro on the same machine
 */

const { createServer } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { hostname } = require('node:os');

const dist = path.join(__dirname, '..', 'dist');
const remote = require(path.join(dist, 'remote', 'index.js'));
const { publishSeratoRemote, decodeOsc } = remote;

const PORT = parseInt(process.env.SERATO_REMOTE_PORT || '0', 10);
const PEER_NAME = process.env.SERATO_REMOTE_PEER || 'serato-capture';
const LOG_PATH = path.join(__dirname, '..', 'capture-raw.log');

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
  return Buffer.from(buf).toString('hex').match(/.{1,2}/g).join(' ');
}

function ascii(buf) {
  let s = '';
  for (const byte of buf) {
    if (byte >= 0x20 && byte < 0x7f) s += String.fromCharCode(byte);
    else s += '.';
  }
  return s;
}

function tryDecodeOsc(buf) {
  // Try at every offset to find a valid OSC address.
  const out = [];
  for (let off = 0; off < Math.min(buf.length, 256); off++) {
    if (buf[off] !== 0x2f) continue; // OSC addresses start with '/'
    try {
      const sub = buf.slice(off);
      const msg = decodeOsc(sub);
      out.push({ offset: off, msg });
    } catch (_) {
      // ignore
    }
  }
  return out;
}

let connId = 0;
const conns = new Map();

const server = createServer((socket) => {
  const id = ++connId;
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  log(`CONN#${id} OPEN from ${peer}`);
  conns.set(id, { peer, totalBytes: 0, chunks: [] });

  socket.on('data', (chunk) => {
    const c = conns.get(id);
    c.totalBytes += chunk.length;
    c.chunks.push(chunk);
    log(`CONN#${id} <- ${chunk.length}B  ${hex(chunk)}`);
    log(`CONN#${id} <- ascii: |${ascii(chunk)}|`);
    // Try to decode any embedded OSC messages
    const found = tryDecodeOsc(chunk);
    for (const { offset, msg } of found) {
      const argFmt = msg.args
        .map((a) => {
          if (a.type === 's') return `s:${JSON.stringify(a.value)}`;
          if (a.type === 'i') return `i:${a.value}`;
          if (a.type === 'f') return `f:${a.value.toFixed(4)}`;
          return `${a.type}:?`;
        })
        .join(' ');
      log(`CONN#${id}    @offset ${offset}: OSC ${msg.address} [${argFmt || '(no args)'}]`);
    }
  });
  socket.on('close', () => {
    const c = conns.get(id);
    log(`CONN#${id} CLOSE  total=${c.totalBytes}B chunks=${c.chunks.length}`);
  });
  socket.on('error', (err) => log(`CONN#${id} ERR ${err.message}`));
});

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
  log('--- WAITING FOR SERATO TO CONNECT (passive observer) ---');

  const shutdown = async () => {
    log('SHUTDOWN');
    await mdns.stop().catch(() => {});
    server.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
