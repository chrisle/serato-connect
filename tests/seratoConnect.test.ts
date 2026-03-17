/**
 * Tests for SeratoConnect incremental history tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SeratoConnect, detectSeratoInstallation } from '../src/seratoConnect.js';
import type { SeratoHistoryPayload, SeratoHistorySong, SeratoDeckChangePayload } from '../src/types.js';
import { CHUNK_TAGS } from '../src/historyParser.js';

/**
 * Convert a 4-character string to uint32 big-endian bytes
 */
function tagToBytes(tag: string): Buffer {
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    buf.writeUInt8(tag.charCodeAt(i), i);
  }
  return buf;
}

/**
 * Create a chunk with tag, length, and data
 */
function createChunk(tag: string, data: Buffer): Buffer {
  const tagBuf = tagToBytes(tag);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  return Buffer.concat([tagBuf, lenBuf, data]);
}

/**
 * Encode a string as UTF-16 Big Endian (matching Serato binary format).
 */
function utf16BE(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

/**
 * Create a string field for session entries (UTF-16 BE encoded).
 */
function stringField(tag: string, value: string): Buffer {
  const valueBuf = utf16BE(value);
  return createChunk(tag, valueBuf);
}

/**
 * Create a uint32 field
 */
function uint32Field(tag: string, value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value, 0);
  return createChunk(tag, data);
}

/**
 * Create a session song entry (OENT > ADAT > fields)
 */
function createSessionEntry(song: Partial<SeratoHistorySong>): Buffer {
  const fields: Buffer[] = [];

  if (song.title) {
    fields.push(stringField(CHUNK_TAGS.TITLE, song.title));
  }
  if (song.artist) {
    fields.push(stringField(CHUNK_TAGS.ARTIST, song.artist));
  }
  if (song.filePath) {
    fields.push(stringField(CHUNK_TAGS.FILE_PATH, song.filePath));
  }
  if (song.bpm !== undefined) {
    fields.push(uint32Field(CHUNK_TAGS.BPM, song.bpm));
  }
  if (song.deck !== undefined) {
    fields.push(uint32Field(CHUNK_TAGS.DECK, song.deck));
  }
  if (song.startTime !== undefined) {
    fields.push(uint32Field(CHUNK_TAGS.START_TIME, Math.floor(song.startTime.getTime() / 1000)));
  }
  if (song.playTime !== undefined) {
    fields.push(uint32Field(CHUNK_TAGS.PLAY_TIME, Math.floor(song.playTime.getTime() / 1000)));
  }
  if (song.played !== undefined) {
    const playedData = Buffer.alloc(1);
    playedData.writeUInt8(song.played ? 1 : 0, 0);
    fields.push(createChunk(CHUNK_TAGS.PLAYED, playedData));
  }

  const adatContent = Buffer.concat(fields);
  const adat = createChunk(CHUNK_TAGS.ADAT, adatContent);
  return createChunk(CHUNK_TAGS.OENT, adat);
}

/**
 * Create a complete session file buffer
 */
function createSessionBuffer(songs: Partial<SeratoHistorySong>[]): Buffer {
  const entries = songs.map(createSessionEntry);
  return Buffer.concat(entries);
}

/**
 * Create a minimal history.database file
 */
function createHistoryDatabaseBuffer(sessions: { date: string; index: number }[]): Buffer {
  const entries = sessions.map(({ date, index }) => {
    const indexField = uint32Field(CHUNK_TAGS.INDEX, index);
    const dateField = stringField(CHUNK_TAGS.SESSION_DATE, date);
    const adatContent = Buffer.concat([indexField, dateField]);
    const adat = createChunk(CHUNK_TAGS.ADAT, adatContent);
    return createChunk(CHUNK_TAGS.OSES, adat);
  });
  return Buffer.concat(entries);
}

describe('SeratoConnect', () => {
  let tempDir: string;
  let seratoPath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serato-connect-test-'));
    seratoPath = path.join(tempDir, '_Serato_');

    // Create Serato folder structure
    await fs.promises.mkdir(path.join(seratoPath, 'History', 'Sessions'), { recursive: true });

    // Create history.database
    const historyDb = createHistoryDatabaseBuffer([{ date: '2024-01-01', index: 1 }]);
    await fs.promises.writeFile(path.join(seratoPath, 'History', 'history.database'), historyDb);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('detectSeratoInstallation', () => {
    it('detects Serato folder', () => {
      const result = detectSeratoInstallation(seratoPath);
      expect(result.found).toBe(true);
      expect(result.path).toBe(seratoPath);
      expect(result.hasHistory).toBe(true);
    });

    it('returns false for non-existent path', () => {
      const result = detectSeratoInstallation('/nonexistent/path');
      expect(result.found).toBe(false);
    });
  });

  describe('Incremental history tracking', () => {
    it('seeds lastHistoryIndex on start to skip existing tracks', async () => {
      // Create initial session with 3 tracks
      const initialSongs = [
        { title: 'Track 1', artist: 'Artist 1', filePath: '/track1.mp3', deck: 1, played: true },
        { title: 'Track 2', artist: 'Artist 2', filePath: '/track2.mp3', deck: 2, played: true },
        { title: 'Track 3', artist: 'Artist 3', filePath: '/track3.mp3', deck: 1, played: true },
      ];
      const sessionBuffer = createSessionBuffer(initialSongs);
      await fs.promises.writeFile(path.join(seratoPath, 'History', 'Sessions', '1.session'), sessionBuffer);

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });
      const historyEvents: SeratoHistoryPayload[] = [];

      connect.on('history', (payload) => {
        historyEvents.push(payload);
      });

      await connect.start();

      // Wait a bit to ensure no initial history event is emitted
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No history events should be emitted on start (cursor seeded to skip existing)
      expect(historyEvents.length).toBe(0);

      connect.stop();
    });

    it('emits only new tracks added after start', async () => {
      // Start with empty session
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const historyEvents: SeratoHistoryPayload[] = [];

      connect.on('history', (payload) => {
        historyEvents.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Add new tracks to the session
      const newSongs = [
        { title: 'New Track 1', artist: 'Artist 1', filePath: '/new1.mp3', deck: 1, played: true },
        { title: 'New Track 2', artist: 'Artist 2', filePath: '/new2.mp3', deck: 2, played: true },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(newSongs)
      );

      // Wait for poll to detect changes
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(historyEvents.length).toBeGreaterThan(0);
      expect(historyEvents[0].count).toBe(2);
      expect(historyEvents[0].tracks.length).toBe(2);
      expect(historyEvents[0].tracks[0].title).toBe('New Track 1');
      expect(historyEvents[0].tracks[1].title).toBe('New Track 2');

      connect.stop();
    });

    it('includes lastTrackIndex in history payload', async () => {
      // Start with empty session
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const historyEvents: SeratoHistoryPayload[] = [];

      connect.on('history', (payload) => {
        historyEvents.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Add 3 tracks
      const songs = [
        { title: 'Track 1', artist: 'Artist 1', filePath: '/t1.mp3', deck: 1, played: true },
        { title: 'Track 2', artist: 'Artist 2', filePath: '/t2.mp3', deck: 2, played: true },
        { title: 'Track 3', artist: 'Artist 3', filePath: '/t3.mp3', deck: 1, played: true },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(historyEvents.length).toBeGreaterThan(0);
      expect(historyEvents[0].lastTrackIndex).toBe(3);

      connect.stop();
    });

    it('emits only incremental tracks on subsequent polls', async () => {
      // Start with 2 tracks
      const initialSongs = [
        { title: 'Track 1', artist: 'Artist 1', filePath: '/t1.mp3', deck: 1, played: true },
        { title: 'Track 2', artist: 'Artist 2', filePath: '/t2.mp3', deck: 2, played: true },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(initialSongs)
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const historyEvents: SeratoHistoryPayload[] = [];

      connect.on('history', (payload) => {
        historyEvents.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 60));

      // No events yet (initial tracks are seeded)
      const initialCount = historyEvents.length;
      expect(initialCount).toBe(0);

      // Add one more track
      const updatedSongs = [
        ...initialSongs,
        { title: 'Track 3', artist: 'Artist 3', filePath: '/t3.mp3', deck: 1, played: true },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(updatedSongs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have one event with only the new track
      expect(historyEvents.length).toBe(1);
      expect(historyEvents[0].count).toBe(1);
      expect(historyEvents[0].tracks[0].title).toBe('Track 3');
      expect(historyEvents[0].lastTrackIndex).toBe(3);

      connect.stop();
    });

    it('resets cursor on new session', async () => {
      // Start with session 1
      const session1Songs = [
        { title: 'Session1 Track 1', artist: 'Artist 1', filePath: '/s1t1.mp3', deck: 1, played: true },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(session1Songs)
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const sessionEvents: { session: { index: number } }[] = [];
      const historyEvents: SeratoHistoryPayload[] = [];

      connect.on('session', (payload) => {
        sessionEvents.push({ session: { index: payload.session.index } });
      });
      connect.on('history', (payload) => {
        historyEvents.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Create a new session file (session 2)
      const session2Songs = [
        { title: 'Session2 Track 1', artist: 'Artist 2', filePath: '/s2t1.mp3', deck: 1, played: true },
        { title: 'Session2 Track 2', artist: 'Artist 2', filePath: '/s2t2.mp3', deck: 2, played: true },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '2.session'),
        createSessionBuffer(session2Songs)
      );

      // Wait for poll to detect new session
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have detected the new session
      expect(sessionEvents.length).toBeGreaterThan(0);

      // Should have emitted all tracks from session 2 (cursor reset)
      const session2History = historyEvents.find(
        (h) => h.tracks.some((t) => t.title === 'Session2 Track 1')
      );
      expect(session2History).toBeDefined();
      expect(session2History!.count).toBe(2);
      expect(session2History!.lastTrackIndex).toBe(2);

      connect.stop();
    });
  });

  describe('start and stop', () => {
    it('emits ready event on start', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });
      const readyPromise = new Promise<{ seratoPath: string; sessionCount: number }>((resolve) => {
        connect.on('ready', resolve);
      });

      await connect.start();
      const readyInfo = await readyPromise;

      expect(readyInfo.seratoPath).toBe(seratoPath);
      expect(readyInfo.sessionCount).toBeGreaterThanOrEqual(0);

      connect.stop();
    });

    it('emits error if Serato folder not found', async () => {
      const connect = new SeratoConnect({
        seratoPath: '/nonexistent/serato/path',
        pollIntervalMs: 100,
      });

      const errorPromise = new Promise<Error>((resolve) => {
        connect.on('error', resolve);
      });

      await connect.start();
      const error = await errorPromise;

      expect(error.message).toContain('No Serato installation found');

      connect.stop();
    });

    it('stops polling on stop()', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      let pollCount = 0;

      connect.on('poll', () => {
        pollCount++;
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 150));

      const countBeforeStop = pollCount;
      connect.stop();

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Poll count should not have increased significantly after stop
      expect(pollCount).toBeLessThanOrEqual(countBeforeStop + 1);
      expect(connect.running).toBe(false);
    });

    it('resets state on stop()', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([
          { title: 'Track 1', artist: 'Artist 1', filePath: '/t1.mp3', deck: 1, played: true },
        ])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(connect.running).toBe(true);

      connect.stop();

      expect(connect.running).toBe(false);
      expect(connect.getNowPlaying()).toBeNull();
    });
  });

  describe('getDeckStates', () => {
    it('returns deck states', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });
      await connect.start();

      const deckStates = connect.getAllDeckStates();
      expect(deckStates).toHaveLength(4);

      connect.stop();
    });
  });

  describe('pollInterval', () => {
    it('returns initial poll interval', () => {
      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 500 });
      expect(connect.pollInterval).toBe(500);
    });

    it('returns default poll interval when not specified', () => {
      const connect = new SeratoConnect({ seratoPath });
      expect(connect.pollInterval).toBe(2000); // default
    });

    it('setPollInterval updates the interval', () => {
      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });
      expect(connect.pollInterval).toBe(100);

      connect.setPollInterval(500);
      expect(connect.pollInterval).toBe(500);
    });

    it('setPollInterval takes effect immediately when running', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      let pollCount = 0;

      connect.on('poll', () => {
        pollCount++;
      });

      await connect.start();

      // Wait for a few polls at 50ms interval
      await new Promise((resolve) => setTimeout(resolve, 180));
      const fastPollCount = pollCount;

      // Change to slower interval
      connect.setPollInterval(500);
      pollCount = 0;

      // Wait same duration - should have fewer polls
      await new Promise((resolve) => setTimeout(resolve, 180));
      const slowPollCount = pollCount;

      // Fast polling should have more polls than slow
      expect(fastPollCount).toBeGreaterThan(slowPollCount);

      connect.stop();
    });
  });

  describe('deckChange events', () => {
    it('emits deckChange when track is loaded on a deck', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];

      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Load a track on deck 1 (has startTime, no playTime = still loaded)
      const songs = [
        {
          title: 'Track 1',
          artist: 'Artist 1',
          filePath: '/track1.mp3',
          deck: 1,
          startTime: new Date(),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(deckChanges.length).toBeGreaterThan(0);
      const deck1Change = deckChanges.find((d) => d.deckId === 1);
      expect(deck1Change).toBeDefined();
      expect(deck1Change!.track).not.toBeNull();
      expect(deck1Change!.track!.title).toBe('Track 1');
      expect(deck1Change!.previousTrack).toBeNull();

      connect.stop();
    });

    it('re-emits deckChange when a loaded track flips to played (NP3-283)', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];
      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Serato writes the history row on load with the same start time it keeps
      // once playback begins, so the key must stay stable across the flip.
      const startTime = new Date();

      // 1. Track loaded but not yet played (DJ-interface only).
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([
          { title: 'Track 1', artist: 'Artist 1', filePath: '/track1.mp3', deck: 1, startTime, played: false },
        ])
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const loadedChange = deckChanges.find((d) => d.deckId === 1 && d.track !== null);
      expect(loadedChange).toBeDefined();
      expect(loadedChange!.track!.played).toBe(false);

      // 2. Serato flips `played` in place — same artist/title/startTime, still on deck.
      deckChanges.length = 0;
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([
          { title: 'Track 1', artist: 'Artist 1', filePath: '/track1.mp3', deck: 1, startTime, played: true },
        ])
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      // The load→play transition must re-emit so the overlay gets the now-playing track.
      const playedChange = deckChanges.find((d) => d.deckId === 1 && d.track?.played === true);
      expect(playedChange).toBeDefined();
      expect(playedChange!.track!.title).toBe('Track 1');

      connect.stop();
    });

    it('emits deckChange when track is ejected from a deck', async () => {
      // Start with a track loaded
      const initialSongs = [
        {
          title: 'Track 1',
          artist: 'Artist 1',
          filePath: '/track1.mp3',
          deck: 1,
          startTime: new Date(Date.now() - 60000),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(initialSongs)
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];

      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Clear changes from initial load
      deckChanges.length = 0;

      // Eject the track (add playTime)
      const ejectedSongs = [
        {
          title: 'Track 1',
          artist: 'Artist 1',
          filePath: '/track1.mp3',
          deck: 1,
          startTime: new Date(Date.now() - 60000),
          playTime: new Date(),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(ejectedSongs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const ejectEvent = deckChanges.find((d) => d.deckId === 1 && d.track === null);
      expect(ejectEvent).toBeDefined();
      expect(ejectEvent!.previousTrack).not.toBeNull();
      expect(ejectEvent!.previousTrack!.title).toBe('Track 1');

      connect.stop();
    });

    it('emits deckChange for each deck independently', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];

      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Load tracks on deck 1 and deck 2
      const songs = [
        {
          title: 'Track A',
          artist: 'Artist A',
          filePath: '/trackA.mp3',
          deck: 1,
          startTime: new Date(),
        },
        {
          title: 'Track B',
          artist: 'Artist B',
          filePath: '/trackB.mp3',
          deck: 2,
          startTime: new Date(),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      const deck1Change = deckChanges.find((d) => d.deckId === 1 && d.track?.title === 'Track A');
      const deck2Change = deckChanges.find((d) => d.deckId === 2 && d.track?.title === 'Track B');

      expect(deck1Change).toBeDefined();
      expect(deck2Change).toBeDefined();

      connect.stop();
    });

    it('does not emit deckChange if deck state unchanged', async () => {
      // Start with a track loaded
      const songs = [
        {
          title: 'Track 1',
          artist: 'Artist 1',
          filePath: '/track1.mp3',
          deck: 1,
          startTime: new Date(Date.now() - 60000),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];

      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Should have initial load event
      const initialCount = deckChanges.length;
      expect(initialCount).toBe(1);

      // Touch the file without changing content (same tracks)
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // No new events - deck state unchanged
      expect(deckChanges.length).toBe(initialCount);

      connect.stop();
    });

    it('getDeckTrack returns track for specific deck', async () => {
      const songs = [
        {
          title: 'Deck 1 Track',
          artist: 'Artist 1',
          filePath: '/d1.mp3',
          deck: 1,
          startTime: new Date(),
        },
        {
          title: 'Deck 3 Track',
          artist: 'Artist 3',
          filePath: '/d3.mp3',
          deck: 3,
          startTime: new Date(),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });
      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(connect.getDeckTrack(1)?.title).toBe('Deck 1 Track');
      expect(connect.getDeckTrack(2)).toBeNull();
      expect(connect.getDeckTrack(3)?.title).toBe('Deck 3 Track');
      expect(connect.getDeckTrack(4)).toBeNull();
      expect(connect.getDeckTrack(0)).toBeNull(); // invalid deck
      expect(connect.getDeckTrack(5)).toBeNull(); // invalid deck

      connect.stop();
    });
  });

  describe('deckless track fallback', () => {
    it('emits deckChange for tracks without deck info via fallback', async () => {
      // Create a session with tracks that have NO deck info (simulating Serato not writing deck)
      const songs = [
        {
          title: 'Deckless Track',
          artist: 'Unknown DJ',
          filePath: '/deckless.mp3',
          startTime: new Date(),
          // No deck field - simulates Serato not providing deck info
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];

      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Fallback should assign the deckless track to virtual deck 1
      expect(deckChanges.length).toBeGreaterThan(0);
      const change = deckChanges.find((d) => d.track?.title === 'Deckless Track');
      expect(change).toBeDefined();
      expect(change!.deckId).toBe(1);

      connect.stop();
    });

    it('assigns multiple deckless tracks to sequential virtual decks', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 50 });
      const deckChanges: SeratoDeckChangePayload[] = [];

      connect.on('deckChange', (payload) => {
        deckChanges.push(payload);
      });

      await connect.start();
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Add two deckless tracks
      const songs = [
        {
          title: 'Track A',
          artist: 'Artist A',
          filePath: '/a.mp3',
          startTime: new Date(),
        },
        {
          title: 'Track B',
          artist: 'Artist B',
          filePath: '/b.mp3',
          startTime: new Date(),
        },
      ];
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer(songs)
      );

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Tracks should be assigned to deck 1 and deck 2 respectively
      const trackA = deckChanges.find((d) => d.track?.title === 'Track A');
      const trackB = deckChanges.find((d) => d.track?.title === 'Track B');
      expect(trackA).toBeDefined();
      expect(trackB).toBeDefined();
      expect(trackA!.deckId).toBe(1);
      expect(trackB!.deckId).toBe(2);

      connect.stop();
    });
  });

  describe('version detection', () => {
    it('returns v3 version for v3 installations', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      const connect = new SeratoConnect({ seratoPath, pollIntervalMs: 100 });
      await connect.start();

      expect(connect.version).toBe('v3');

      connect.stop();
    });

    it('detectSeratoInstallation returns v3 for custom path with History folder', () => {
      const result = detectSeratoInstallation(seratoPath);
      expect(result.found).toBe(true);
      expect(result.hasHistory).toBe(true);
      expect(result.version).toBe('v3');
      expect(result.path).toBe(seratoPath);
    });

    it('detectSeratoInstallation returns unknown for custom path without History', async () => {
      // Create a temp directory without History folder
      const tempPath = path.join(os.tmpdir(), 'serato-test-no-history-' + Date.now());
      await fs.promises.mkdir(tempPath, { recursive: true });

      try {
        const result = detectSeratoInstallation(tempPath);
        expect(result.found).toBe(true);
        expect(result.hasHistory).toBe(false);
        expect(result.version).toBe('unknown');
      } finally {
        await fs.promises.rm(tempPath, { recursive: true, force: true });
      }
    });

    it('forceVersion option forces v3 mode', async () => {
      await fs.promises.writeFile(
        path.join(seratoPath, 'History', 'Sessions', '1.session'),
        createSessionBuffer([])
      );

      // Force v3 mode even if v4 is available
      const connect = new SeratoConnect({
        seratoPath,
        pollIntervalMs: 100,
        forceVersion: 'v3',
      });

      await connect.start();

      expect(connect.version).toBe('v3');

      connect.stop();
    });
  });
});
