# serato-connect

Library for reading Serato DJ history files and emitting events when tracks change. Built to decouple Serato integration out of NowPlaying into a standalone, reusable package.

## Features

- Polls Serato history session files for changes (mtime-based)
- Typed events: `ready`, `poll`, `track`, `history`, `session`, `error`
- Parses Serato's binary history format
- Tracks deck states (which deck is playing what)
- Detects currently playing track across multiple decks
- Configurable polling interval and history limits
- Zero external dependencies (besides `strict-event-emitter-types` for typing)

## Quick Start

```ts
import { SeratoConnect } from 'serato-connect';

const serato = new SeratoConnect({ pollIntervalMs: 2000 });

serato.on('ready', (info) => {
  console.log('Serato ready:', info.seratoPath, 'sessions:', info.sessionCount);
});

serato.on('track', (payload) => {
  console.log('Now playing:', payload.track.artist, '-', payload.track.title);
  console.log('Deck:', payload.deckId);
});

serato.on('history', (payload) => {
  console.log('New history entries:', payload.count);
});

serato.on('session', (payload) => {
  console.log('New session detected:', payload.session.date);
});

serato.start();

// later
// serato.stop();
```

## API

### `new SeratoConnect(options?)`

Options:

- `seratoPath?: string` — Path to the `_Serato_` folder. If omitted, uses default location (`~/Music/_Serato_`).
- `pollIntervalMs?: number` — Milliseconds between file mtime polls. Default `2000`.
- `historyMaxRows?: number` — Limit for tracks in `history` emission. Default `100`.

Methods:

- `start()` — Locate history files, emit initial `ready`, and begin polling.
- `stop()` — Stop polling and reset internal state.
- `getNowPlaying()` — Get the currently playing track (or `null`).
- `getDeckStates()` — Get all 4 deck states.
- `running` — Boolean indicating if monitoring is active.

Events:

- `ready` — `{ seratoPath, sessionCount }` when history is loaded.
- `poll` — Emitted on each poll cycle.
- `track` — `{ track, deckId }` when the currently playing track changes.
- `history` — `{ seratoPath, count, tracks }` with recent history entries.
- `session` — `{ session }` when a new session is detected.
- `error` — `(error)` for any recoverable errors.

### Utility Functions

```ts
import {
  getDefaultSeratoPath,
  detectSeratoInstallation,
  getSeratoHistory,
} from 'serato-connect';

// Get default _Serato_ path for current platform
const path = getDefaultSeratoPath();

// Check if Serato is installed
const { found, path, hasHistory } = detectSeratoInstallation();

// Get all history sessions
const sessions = await getSeratoHistory('/path/to/_Serato_');
```

## Serato History Format

Serato stores its play history in:
- `~/Music/_Serato_/History/history.database` — Index of all sessions
- `~/Music/_Serato_/History/Sessions/{n}.session` — Individual session files

The binary format uses a chunk-based structure with 4-byte tags and lengths. Each track entry contains:
- Title, Artist, File Path
- BPM
- Start Time, Play Time
- Deck number (1-4)
- Played flag

## Notes

- Serato writes history in real-time as you play tracks
- The "currently playing" track is detected by having a start time but no play time yet
- When multiple decks are playing, the track that started first is considered "now playing"
- Session files are indexed by number, with higher numbers being more recent

## License

See repository license.
