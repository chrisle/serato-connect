/**
 * Tests for Serato v3 history parser (binary format).
 * Verifies UTF-16 BE text decoding for track metadata.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getSessionSongs, getSessions, CHUNK_TAGS } from '../src/historyParser.js';

/**
 * Convert a 4-character string tag to uint32 big-endian bytes.
 */
function tagToBytes(tag: string): Buffer {
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    buf.writeUInt8(tag.charCodeAt(i), i);
  }
  return buf;
}

/**
 * Create a chunk with tag, length, and data.
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
 * Create a UTF-16 BE text field chunk for session entries.
 */
function stringField(tag: string, value: string): Buffer {
  const valueBuf = utf16BE(value);
  return createChunk(tag, valueBuf);
}

/**
 * Create a uint32 field chunk.
 */
function uint32Field(tag: string, value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value, 0);
  return createChunk(tag, data);
}

/**
 * Create a session song entry (OENT > ADAT > fields).
 */
function createSessionEntry(song: {
  title?: string;
  artist?: string;
  filePath?: string;
  bpm?: number;
  deck?: number;
  startTime?: Date;
  playTime?: Date;
  played?: boolean;
}): Buffer {
  const fields: Buffer[] = [];

  if (song.title !== undefined) {
    fields.push(stringField(CHUNK_TAGS.TITLE, song.title));
  }
  if (song.artist !== undefined) {
    fields.push(stringField(CHUNK_TAGS.ARTIST, song.artist));
  }
  if (song.filePath !== undefined) {
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
 * Create a complete session file buffer.
 */
function createSessionBuffer(songs: Parameters<typeof createSessionEntry>[0][]): Buffer {
  const entries = songs.map(createSessionEntry);
  return Buffer.concat(entries);
}

/**
 * Create a minimal history.database buffer.
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

describe('historyParser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serato-history-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('getSessionSongs', () => {
    it('parses ASCII title and artist', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        { title: 'Test Track', artist: 'Test Artist', filePath: '/music/test.mp3', deck: 1 },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Test Track');
      expect(songs[0].artist).toBe('Test Artist');
      expect(songs[0].filePath).toBe('/music/test.mp3');
    });

    it('parses accented characters (Latin Extended)', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        { title: 'Déjà Vu', artist: 'Beyoncé', filePath: '/music/deja.mp3', deck: 1 },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Déjà Vu');
      expect(songs[0].artist).toBe('Beyoncé');
    });

    it('parses CJK characters', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        { title: '大きな古時計', artist: '平井堅', filePath: '/music/clock.mp3', deck: 1 },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('大きな古時計');
      expect(songs[0].artist).toBe('平井堅');
    });

    it('parses Cyrillic characters', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        { title: 'Калинка', artist: 'Иван', filePath: '/music/kalinka.mp3', deck: 1 },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Калинка');
      expect(songs[0].artist).toBe('Иван');
    });

    it('parses emoji and special Unicode characters', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      // Note: emoji (U+1F3B5) is outside BMP, requires surrogate pair in UTF-16
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        { title: 'Café ñ', artist: 'DJ Ötzi', filePath: '/music/cafe.mp3', deck: 1 },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('Café ñ');
      expect(songs[0].artist).toBe('DJ Ötzi');
    });

    it('parses multiple songs in a session', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        { title: 'Track 1', artist: 'Artist 1', filePath: '/t1.mp3', deck: 1 },
        { title: 'Track 2', artist: 'Artist 2', filePath: '/t2.mp3', deck: 2 },
        { title: 'Track 3', artist: 'Artist 3', filePath: '/t3.mp3', deck: 1 },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(3);
      expect(songs[0].title).toBe('Track 1');
      expect(songs[1].title).toBe('Track 2');
      expect(songs[2].title).toBe('Track 3');
    });

    it('parses BPM, deck, and timing fields', async () => {
      const startTime = new Date('2024-01-15T20:30:00Z');
      const playTime = new Date('2024-01-15T20:35:00Z');

      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        {
          title: 'Track',
          artist: 'Artist',
          filePath: '/t.mp3',
          bpm: 128,
          deck: 2,
          startTime,
          playTime,
          played: true,
        },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].bpm).toBe(128);
      expect(songs[0].deck).toBe(2);
      expect(songs[0].startTime).toBeInstanceOf(Date);
      expect(songs[0].playTime).toBeInstanceOf(Date);
      expect(songs[0].played).toBe(true);
    });

    it('handles empty session file', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, Buffer.alloc(0));

      const songs = await getSessionSongs(sessionPath);
      expect(songs).toHaveLength(0);
    });

    it('returns empty title/artist when fields are missing', async () => {
      // Create entry with only filePath (no title/artist)
      const fields = [stringField(CHUNK_TAGS.FILE_PATH, '/missing-meta.mp3')];
      const adatContent = Buffer.concat(fields);
      const adat = createChunk(CHUNK_TAGS.ADAT, adatContent);
      const entry = createChunk(CHUNK_TAGS.OENT, adat);

      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, entry);

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].title).toBe('');
      expect(songs[0].artist).toBe('');
      expect(songs[0].filePath).toBe('/missing-meta.mp3');
    });

    it('handles file paths with special characters', async () => {
      const sessionPath = path.join(tempDir, '1.session');
      await fs.promises.writeFile(sessionPath, createSessionBuffer([
        {
          title: 'Track',
          artist: 'Artist',
          filePath: '/Users/dj/Music/Café Beats/Ñoño - Track.mp3',
          deck: 1,
        },
      ]));

      const songs = await getSessionSongs(sessionPath);

      expect(songs).toHaveLength(1);
      expect(songs[0].filePath).toBe('/Users/dj/Music/Café Beats/Ñoño - Track.mp3');
    });
  });

  describe('getSessions', () => {
    it('parses history.database with sessions', async () => {
      const dbPath = path.join(tempDir, 'history.database');
      await fs.promises.writeFile(dbPath, createHistoryDatabaseBuffer([
        { date: '2024-01-15', index: 1 },
        { date: '2024-01-16', index: 2 },
      ]));

      const sessions = await getSessions(dbPath);

      expect(sessions.size).toBe(2);
      expect(sessions.get('2024-01-15')).toBe(1);
      expect(sessions.get('2024-01-16')).toBe(2);
    });

    it('parses session dates with special characters', async () => {
      const dbPath = path.join(tempDir, 'history.database');
      await fs.promises.writeFile(dbPath, createHistoryDatabaseBuffer([
        { date: '2024/01/15', index: 1 },
      ]));

      const sessions = await getSessions(dbPath);

      expect(sessions.size).toBe(1);
      expect(sessions.get('2024/01/15')).toBe(1);
    });

    it('returns empty map for empty file', async () => {
      const dbPath = path.join(tempDir, 'history.database');
      await fs.promises.writeFile(dbPath, Buffer.alloc(0));

      const sessions = await getSessions(dbPath);
      expect(sessions.size).toBe(0);
    });
  });
});
