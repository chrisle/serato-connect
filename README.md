# serato-connect

A comprehensive library for reading Serato DJ data, including history files, cue points, beatgrid, crates, and the full track library.

## Features

### Real-time Monitoring
- Polls Serato history session files for changes (mtime-based)
- Typed events: `ready`, `poll`, `track`, `history`, `session`, `error`
- Tracks deck states (which deck is playing what)
- Detects currently playing track across multiple decks

### Track Metadata (GEOB Parsing)
- Read cue points, loops, and flip recordings from audio files
- Parse beatgrid data with tempo changes
- Extract track color and BPM lock status
- Support for MP3, AIFF, FLAC, Ogg Vorbis, and M4A/MP4

### Library Access
- Parse crate files to list track collections
- Read the full Serato database (Database V2)
- Search tracks by title, artist, album
- Get library statistics

## Installation

```bash
npm install serato-connect
```

## Quick Start

```ts
import { SeratoConnect } from 'serato-connect';

const serato = new SeratoConnect();

// Real-time track monitoring
serato.on('track', async (payload) => {
  console.log('Now playing:', payload.track.artist, '-', payload.track.title);

  // Get cue points and beatgrid from the audio file
  const metadata = await serato.getTrackMetadata(payload.track.filePath);
  if (metadata?.markers) {
    console.log('Cue points:', metadata.markers.cuePoints);
    console.log('Track color:', metadata.markers.trackColor);
  }

  // Find which crates contain this track
  const crates = await serato.findCratesForTrack(payload.track.filePath);
  console.log('In crates:', crates);
});

serato.start();
```

## API

### SeratoConnect Class

```ts
const serato = new SeratoConnect({
  seratoPath?: string,      // Path to _Serato_ folder (default: ~/Music/_Serato_)
  pollIntervalMs?: number,  // Polling interval in ms (default: 2000)
  historyMaxRows?: number,  // Max history entries per event (default: 100)
});
```

#### Monitoring Methods

- `start()` — Begin monitoring history files
- `stop()` — Stop monitoring
- `getNowPlaying()` — Get currently playing track
- `getDeckStates()` — Get all 4 deck states
- `running` — Boolean indicating if monitoring is active

#### Library Methods

- `getTrackMetadata(filePath)` — Read GEOB metadata from audio file
- `getCrates()` — Get all crates
- `getCrate(name)` — Get a specific crate
- `findCratesForTrack(filePath)` — Find crates containing a track
- `getLibraryTracks({ limit?, offset? })` — Get tracks from database
- `searchLibrary(query)` — Search tracks
- `getDatabaseStats()` — Get library statistics

#### Events

- `ready` — `{ seratoPath, sessionCount }` when history is loaded
- `poll` — Emitted on each poll cycle
- `track` — `{ track, deckId }` when currently playing track changes
- `history` — `{ seratoPath, count, tracks }` with recent history entries
- `session` — `{ session }` when a new session is detected
- `error` — `(error)` for any recoverable errors

### Standalone Functions

#### Track Metadata

```ts
import { getTrackMetadata } from 'serato-connect';

const metadata = await getTrackMetadata('/path/to/track.mp3');
console.log(metadata.markers?.cuePoints);  // Cue points
console.log(metadata.markers?.loops);       // Loops
console.log(metadata.beatgrid?.markers);    // Beatgrid
console.log(metadata.autotags?.bpm);        // Analyzed BPM
```

#### GEOB Parsers (Low-level)

```ts
import {
  parseMarkers2,
  parseBeatgrid,
  parseAutotags,
} from 'serato-connect';

// Parse raw GEOB frame data
const markers = parseMarkers2(geobBuffer);
const beatgrid = parseBeatgrid(beatgridBuffer);
```

#### Crates

```ts
import { getAllCrates, parseCrate, findCratesForTrack } from 'serato-connect';

const crates = await getAllCrates('/path/to/_Serato_');
const crate = await parseCrate('/path/to/crate.crate');
const crateNames = await findCratesForTrack('/path/to/_Serato_', '/path/to/track.mp3');
```

#### Database

```ts
import {
  getLibraryTracks,
  searchLibrary,
  getDatabaseStats,
} from 'serato-connect';

const tracks = await getLibraryTracks('/path/to/_Serato_');
const results = await searchLibrary('/path/to/_Serato_', 'daft punk');
const stats = await getDatabaseStats('/path/to/_Serato_');
```

#### Encoding Utilities

```ts
import {
  decodeSerato32,
  encodeSerato32,
  decodeWithLinebreaks,
  encodeWithLinebreaks,
} from 'serato-connect';

// Serato32 encoding (for colors and positions)
const [r, g, b] = decodeSerato32(enc1, enc2, enc3, enc4);

// Base64 with linebreaks (for FLAC/Vorbis comments)
const decoded = decodeWithLinebreaks(base64String);
```

## Types

```ts
interface SeratoCuePoint {
  index: number;          // 0-7
  position: number;       // Milliseconds
  color: SeratoColor;     // { r, g, b }
  name?: string;          // Up to 51 chars
}

interface SeratoLoop {
  index: number;
  startPosition: number;  // Milliseconds
  endPosition: number;    // Milliseconds
  color: SeratoColor;     // { r, g, b, a }
  locked: boolean;
  name?: string;
}

interface SeratoBeatgridMarker {
  position: number;       // Seconds
  bpm?: number;           // Terminal marker only
  beatsToNext?: number;   // Non-terminal markers
}

interface SeratoCrate {
  name: string;
  path: string;
  trackPaths: string[];
}

interface SeratoDatabaseTrack {
  filePath: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  key?: string;
  bpm?: number;
  // ... and more
}
```

## Attribution

This library's format parsing is based on research and code from:

- **[triseratops](https://github.com/Holzhaus/triseratops)** by @Holzhaus — Rust library for Serato metadata (MPL-2.0)
- **[serato-tags](https://github.com/Holzhaus/serato-tags)** by @Holzhaus — Format documentation
- **[serato-tools](https://github.com/bvandercar-vt/serato-tools)** by @bvandercar-vt — Python library for Serato data
- **[seratoparser](https://github.com/SpinTools/seratoparser)** by @SpinTools — Go library for Serato database
- **[Mixxx Wiki](https://github.com/mixxxdj/mixxx/wiki/serato_database_format)** — Database format documentation
- **[music-metadata](https://github.com/Borewit/music-metadata)** by @Borewit — Audio file tag reading

## Related Packages

- [alphatheta-connect](https://github.com/chrisle/alphatheta-connect) — Pioneer Pro DJ Link integration
- [rekordbox-connect](https://github.com/chrisle/rekordbox-connect) — Rekordbox database integration
- [stagelinq](https://github.com/chrisle/stagelinq) — Denon StageLinq integration

These libraries power [Now Playing](https://nowplayingapp.com) — a real-time track display app for DJs and streamers.

## License

MIT
