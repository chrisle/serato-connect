/**
 * Tests for SeratoConnect incremental history tracking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SeratoConnect, detectSeratoInstallation } from '../src/seratoConnect.js';
import type { SeratoHistoryPayload, SeratoHistorySong } from '../src/types.js';
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
 * Create a string field for session entries
 */
function stringField(tag: string, value: string): Buffer {
  // Pad with null byte
  const valueBuf = Buffer.from(value + '\0', 'latin1');
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

      expect(error.message).toContain('Serato folder not found');

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

      const deckStates = connect.getDeckStates();
      expect(deckStates).toHaveLength(4);

      connect.stop();
    });
  });
});
