#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * serato-connect realtime monitor — a live terminal dashboard.
 *
 * Advertises the `_SeratoIOSRemote._tcp` Bonjour service, lets Serato DJ Pro
 * connect, drives the handshake, and renders the realtime state Serato pushes:
 *
 *   - which deck has which track loaded, and whether it's playing
 *   - live playhead position for each deck
 *   - loop / loop-roll toggles (the "button-like" state the protocol exposes)
 *   - channel upfaders and the crossfader
 *
 * Run it, then open Serato DJ Pro on the same machine/network — it auto-connects.
 *
 *   npm run build && node examples/monitor.js      # or: npm run demo
 *   node examples/monitor.js --log                 # plain scrolling log instead
 *
 * NOTE ON SCOPE: the Serato Remote protocol carries *derived* state, not raw
 * controller input. Hot-cue / play / cue button presses and EQ-knob positions
 * are NOT exposed here (they only exist over MIDI, via the desktop app's MIDI
 * bridge). The loop toggles and faders below are everything button/knob-ish the
 * protocol actually sends.
 */

const path = require('node:path');
const { SeratoRemoteClient, NUM_REMOTE_DECKS } = require(
  path.join(__dirname, '..', 'dist', 'index.js'),
);

const LOG_MODE = process.argv.includes('--log');
const PEER_NAME = process.env.PEER_NAME || 'serato-connect demo';

// ── ANSI helpers ────────────────────────────────────────────────────────────
const A = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bgGreen: '\x1b[42m\x1b[30m',
};
const c = (color, s) => `${A[color]}${s}${A.reset}`;

// ── State ───────────────────────────────────────────────────────────────────
// Per-deck (1-based; index 0 unused).
const decks = Array.from({ length: NUM_REMOTE_DECKS + 1 }, () => ({
  track: null, // { title, artist, filePath, valid }
  pos: 0, // playhead float[0] — position in seconds
  rate: 0, // playhead float[1] — play rate (0 = stopped, 1 = normal)
  bpm: 0, // playhead float[2] — current pitch-adjusted BPM
  loop: {}, // { autoLoopOn, beatLength, loopRollOn }
}));
let mixer = { crossfader: undefined, upfaders: [] };
let status = { ready: false, connected: false, paired: false, instanceName: '', port: 0 };
const eventLog = []; // rolling, most-recent-last

function logEvent(line) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  eventLog.push(`${c('gray', ts)} ${line}`);
  if (eventLog.length > 12) eventLog.shift();
  if (LOG_MODE) console.log(`${c('gray', ts)} ${line}`);
}

// ── Formatting ──────────────────────────────────────────────────────────────
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Horizontal 0..1 bar, `width` chars, with a filled portion. */
function bar(value, width = 20) {
  if (value == null || !Number.isFinite(value)) return c('gray', '─'.repeat(width));
  const v = Math.max(0, Math.min(1, value));
  const filled = Math.round(v * width);
  return c('green', '█'.repeat(filled)) + c('gray', '░'.repeat(width - filled));
}

/** Crossfader bar with a marker showing position across the width. */
function crossfaderBar(value, width = 21) {
  if (value == null) return c('gray', '─'.repeat(width));
  const v = Math.max(0, Math.min(1, value));
  const pos = Math.round(v * (width - 1));
  let out = '';
  for (let i = 0; i < width; i++) {
    if (i === pos) out += c('cyan', '◆');
    else if (i === Math.floor((width - 1) / 2)) out += c('gray', '┊');
    else out += c('gray', '─');
  }
  return out;
}

function deckPlayState(d) {
  const loaded = d.track && d.track.valid !== false && (d.track.title || d.track.filePath);
  if (!loaded) return { icon: c('gray', '⏹'), label: c('gray', 'empty') };
  // playRate > 0 means the deck is playing (it's the pitch multiplier).
  return d.rate > 0.001
    ? { icon: c('green', '▶'), label: c('green', 'PLAYING') }
    : { icon: c('yellow', '⏸'), label: c('yellow', 'paused ') };
}

/** Signed pitch percentage from the play rate (rate 0.92 → −8.0%). */
function pitchPct(rate) {
  if (!rate) return '';
  const p = (rate - 1) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
}

// ── Dashboard render ────────────────────────────────────────────────────────
function render() {
  const L = [];
  L.push('');
  L.push(
    `  ${c('bold', c('magenta', 'serato-connect'))} ${c('dim', '· realtime Serato Remote monitor')}`,
  );

  const conn = status.paired
    ? c('bgGreen', ' PAIRED ')
    : status.connected
      ? c('yellow', 'connecting…')
      : status.ready
        ? c('cyan', 'waiting for Serato')
        : c('gray', 'starting…');
  L.push(
    `  ${conn}   ${c('dim', 'advert:')} ${status.instanceName || '—'}  ${c('dim', 'port:')} ${status.port || '—'}`,
  );
  L.push('');

  // Decks
  for (let id = 1; id <= NUM_REMOTE_DECKS; id++) {
    const d = decks[id];
    const ps = deckPlayState(d);
    const t = d.track;
    const title = t && (t.title || '') ? t.title : '';
    const artist = t && (t.artist || '') ? t.artist : '';
    const label =
      title || artist
        ? `${c('bold', title || '(untitled)')}${artist ? c('dim', '  — ' + artist) : ''}`
        : c('gray', '— no track loaded —');

    L.push(`  ${c('blue', 'Deck ' + id)}  ${ps.icon} ${ps.label}   ${label}`);

    // position line + loop toggles
    const posLine = fmtTime(d.pos);
    const bpm = d.bpm ? `${d.bpm.toFixed(1)} bpm` : '';
    const pitch = d.rate ? c('dim', pitchPct(d.rate)) : '';
    const toggles = [];
    if (d.loop.autoLoopOn) toggles.push(c('bgGreen', ' LOOP '));
    if (d.loop.loopRollOn) toggles.push(c('magenta', '[ROLL]'));
    const beats = d.loop.beatLength != null ? c('dim', `${d.loop.beatLength} beat`) : '';
    L.push(
      `          ${c('gray', posLine)}  ${c('dim', bpm)} ${pitch}   ${toggles.join(' ')} ${beats}`.trimEnd(),
    );
  }
  L.push('');

  // Mixer
  L.push(`  ${c('cyan', 'Mixer')}`);
  for (let id = 1; id <= NUM_REMOTE_DECKS; id++) {
    const v = mixer.upfaders[id];
    const pct = v == null ? '  —' : `${Math.round(v * 100)}%`.padStart(3);
    L.push(`    ${c('dim', 'ch' + id + ' fader')} ${bar(v, 22)} ${c('gray', pct)}`);
  }
  L.push(
    `    ${c('dim', 'crossfader')} ${crossfaderBar(mixer.crossfader, 22)} ${c('gray', mixer.crossfader == null ? '  —' : mixer.crossfader.toFixed(2))}`,
  );
  L.push('');

  // Event log
  L.push(`  ${c('dim', 'events')}`);
  const recent = eventLog.slice(-8);
  if (recent.length === 0) L.push(`    ${c('gray', '(none yet — load a track or move a fader)')}`);
  for (const e of recent) L.push(`    ${e}`);
  L.push('');
  L.push(c('gray', '  Note: hot-cue/play buttons and EQ knobs are not in the Serato Remote'));
  L.push(c('gray', '  protocol — only loop toggles and faders are. Ctrl-C to quit.'));
  L.push('');

  // Paint: home cursor, write each line clearing to end-of-line, clear below.
  process.stdout.write('\x1b[H' + L.map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
}

// ── Wire up the client ──────────────────────────────────────────────────────
const client = new SeratoRemoteClient({ peerName: PEER_NAME });

client.on('ready', (info) => {
  status.ready = true;
  status.instanceName = info.instanceName;
  status.port = info.port;
  logEvent(c('cyan', `advertising "${info.instanceName}" on :${info.port}`));
});
client.on('peerConnected', () => {
  if (!status.connected) logEvent(c('yellow', 'Serato connected'));
  status.connected = true;
});
client.on('paired', () => {
  status.paired = true;
  logEvent(c('green', 'paired — streaming'));
});
client.on('peerDisconnected', () => {
  status.connected = false;
  status.paired = false;
  logEvent(c('red', 'Serato disconnected'));
});

client.on('deckChange', ({ deckId, track, previousTrack }) => {
  decks[deckId].track = track;
  const has = (t) => t && (t.title || t.artist);
  if (has(track)) {
    logEvent(
      `${c('blue', 'deck ' + deckId)} loaded ${c('bold', track.title || '(untitled)')}${track.artist ? ' — ' + track.artist : ''}`,
    );
  } else if (has(previousTrack)) {
    // Only report an eject if something was actually loaded before.
    logEvent(`${c('blue', 'deck ' + deckId)} ${c('gray', 'ejected')}`);
  }
});

client.on('playhead', ({ deckId, playhead }) => {
  const d = decks[deckId];
  d.pos = playhead.positionSeconds ?? 0;
  d.rate = playhead.playRate ?? 0;
  d.bpm = playhead.bpm ?? d.bpm;
});

client.on('loopChange', ({ deckId, loop }) => {
  const prev = decks[deckId].loop;
  decks[deckId].loop = loop;
  if (loop.autoLoopOn !== prev.autoLoopOn)
    logEvent(
      `${c('blue', 'deck ' + deckId)} loop ${loop.autoLoopOn ? c('green', 'ON') : c('gray', 'off')}${loop.beatLength != null ? ` (${loop.beatLength} beat)` : ''}`,
    );
  if (loop.loopRollOn !== prev.loopRollOn)
    logEvent(
      `${c('blue', 'deck ' + deckId)} loop-roll ${loop.loopRollOn ? c('magenta', 'ON') : c('gray', 'off')}`,
    );
});

client.on('mixerChange', ({ mixer: m }) => {
  mixer = m;
});

client.on('error', (err) => logEvent(c('red', `error: ${err.message}`)));

async function main() {
  if (!LOG_MODE) process.stdout.write('\x1b[2J\x1b[H\x1b[?25l'); // clear + hide cursor
  await client.start();

  let timer = null;
  if (!LOG_MODE) timer = setInterval(render, 100);

  const shutdown = async () => {
    if (timer) clearInterval(timer);
    if (!LOG_MODE) process.stdout.write('\x1b[?25h\n'); // show cursor
    console.log('shutting down…');
    await client.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
