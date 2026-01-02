/**
 * Tests for Serato Database V2 parser.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseDatabase,
  parseDatabaseSync,
  getLibraryTracks,
  getTrackByPath,
  searchLibrary,
  getDatabaseStats,
} from '../../src/parsers/database.js';

/**
 * Create a UTF-16 BE encoded string buffer.
 */
function utf16BE(str: string): Buffer {
  const buf = Buffer.alloc(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    buf.writeUInt16BE(str.charCodeAt(i), i * 2);
  }
  return buf;
}

/**
 * Create a text field chunk (t* prefix).
 */
function textField(tag: string, value: string): Buffer {
  const data = utf16BE(value);
  const chunk = Buffer.alloc(8 + data.length);
  chunk.write(tag, 0, 4, 'ascii');
  chunk.writeUInt32BE(data.length, 4);
  data.copy(chunk, 8);
  return chunk;
}

/**
 * Create a path field chunk (p* prefix).
 */
function pathField(tag: string, value: string): Buffer {
  return textField(tag, value);
}

/**
 * Create a boolean field chunk (b* prefix).
 */
function boolField(tag: string, value: boolean): Buffer {
  const chunk = Buffer.alloc(9);
  chunk.write(tag, 0, 4, 'ascii');
  chunk.writeUInt32BE(1, 4);
  chunk.writeUInt8(value ? 1 : 0, 8);
  return chunk;
}

/**
 * Create a uint32 field chunk (u* prefix).
 */
function uint32Field(tag: string, value: number): Buffer {
  const chunk = Buffer.alloc(12);
  chunk.write(tag, 0, 4, 'ascii');
  chunk.writeUInt32BE(4, 4);
  chunk.writeUInt32BE(value, 8);
  return chunk;
}

/**
 * Create a track entry (otrk wrapper).
 */
function createTrack(fields: Buffer[]): Buffer {
  const content = Buffer.concat(fields);
  const chunk = Buffer.alloc(8 + content.length);
  chunk.write('otrk', 0, 4, 'ascii');
  chunk.writeUInt32BE(content.length, 4);
  content.copy(chunk, 8);
  return chunk;
}

/**
 * Create a database buffer with the given tracks.
 */
function createDatabaseBuffer(tracks: Buffer[]): Buffer {
  // Version header
  const versionData = utf16BE('1.0/Serato Database V2');
  const versionChunk = Buffer.alloc(8 + versionData.length);
  versionChunk.write('vrsn', 0, 4, 'ascii');
  versionChunk.writeUInt32BE(versionData.length, 4);
  versionData.copy(versionChunk, 8);

  return Buffer.concat([versionChunk, ...tracks]);
}

describe('Database parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serato-db-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('parseDatabase', () => {
    it('parses database with tracks', async () => {
      const track1 = createTrack([
        pathField('pfil', '/Users/dj/Music/track1.mp3'),
        textField('tsng', 'First Song'),
        textField('tart', 'Artist One'),
      ]);

      const track2 = createTrack([
        pathField('pfil', '/Users/dj/Music/track2.mp3'),
        textField('tsng', 'Second Song'),
        textField('tart', 'Artist Two'),
        textField('talb', 'Album Name'),
      ]);

      const dbBuffer = createDatabaseBuffer([track1, track2]);
      const dbPath = path.join(tempDir, 'database V2');
      await fs.promises.writeFile(dbPath, dbBuffer);

      const tracks = await parseDatabase(dbPath);

      expect(tracks.length).toBe(2);

      expect(tracks[0].filePath).toBe('/Users/dj/Music/track1.mp3');
      expect(tracks[0].title).toBe('First Song');
      expect(tracks[0].artist).toBe('Artist One');

      expect(tracks[1].filePath).toBe('/Users/dj/Music/track2.mp3');
      expect(tracks[1].title).toBe('Second Song');
      expect(tracks[1].artist).toBe('Artist Two');
      expect(tracks[1].album).toBe('Album Name');
    });

    it('parses track with all metadata fields', async () => {
      const track = createTrack([
        pathField('pfil', '/path/to/track.mp3'),
        textField('tsng', 'Song Title'),
        textField('tart', 'Song Artist'),
        textField('talb', 'Song Album'),
        textField('tgen', 'House'),
        textField('tkey', 'Am'),
        textField('tbpm', '128.00'),
        textField('tlen', '180.5'),
        textField('tbit', '320'),
        textField('tsmp', '44100'),
        textField('ttyp', 'mp3'),
        boolField('bbgl', true),
        boolField('bmis', false),
        uint32Field('uadd', Math.floor(Date.now() / 1000)),
        textField('tcom', 'Great track!'),
        textField('tgrp', 'My Group'),
        textField('tcmp', 'The Composer'),
        textField('tlbl', 'Record Label'),
        textField('ttyr', '2024'),
      ]);

      const dbBuffer = createDatabaseBuffer([track]);
      const dbPath = path.join(tempDir, 'database V2');
      await fs.promises.writeFile(dbPath, dbBuffer);

      const tracks = await parseDatabase(dbPath);

      expect(tracks.length).toBe(1);
      const t = tracks[0];

      expect(t.filePath).toBe('/path/to/track.mp3');
      expect(t.title).toBe('Song Title');
      expect(t.artist).toBe('Song Artist');
      expect(t.album).toBe('Song Album');
      expect(t.genre).toBe('House');
      expect(t.key).toBe('Am');
      expect(t.bpm).toBeCloseTo(128.0, 2);
      expect(t.length).toBeCloseTo(180.5, 1);
      expect(t.bitrate).toBe(320);
      expect(t.sampleRate).toBe(44100);
      expect(t.fileType).toBe('mp3');
      expect(t.beatgridLocked).toBe(true);
      expect(t.missing).toBe(false);
      expect(t.dateAdded).toBeInstanceOf(Date);
      expect(t.comment).toBe('Great track!');
      expect(t.grouping).toBe('My Group');
      expect(t.composer).toBe('The Composer');
      expect(t.label).toBe('Record Label');
      expect(t.year).toBe(2024);
    });

    it('skips tracks without file path', async () => {
      const validTrack = createTrack([
        pathField('pfil', '/path/to/valid.mp3'),
        textField('tsng', 'Valid'),
      ]);

      const invalidTrack = createTrack([
        textField('tsng', 'No Path'),
        textField('tart', 'Artist'),
      ]);

      const dbBuffer = createDatabaseBuffer([validTrack, invalidTrack]);
      const dbPath = path.join(tempDir, 'database V2');
      await fs.promises.writeFile(dbPath, dbBuffer);

      const tracks = await parseDatabase(dbPath);

      expect(tracks.length).toBe(1);
      expect(tracks[0].title).toBe('Valid');
    });

    it('returns empty array for empty database', async () => {
      const dbBuffer = createDatabaseBuffer([]);
      const dbPath = path.join(tempDir, 'database V2');
      await fs.promises.writeFile(dbPath, dbBuffer);

      const tracks = await parseDatabase(dbPath);

      expect(tracks).toEqual([]);
    });
  });

  describe('parseDatabaseSync', () => {
    it('parses database synchronously', async () => {
      const track = createTrack([
        pathField('pfil', '/sync/test.mp3'),
        textField('tsng', 'Sync Test'),
      ]);

      const dbBuffer = createDatabaseBuffer([track]);
      const dbPath = path.join(tempDir, 'database V2');
      await fs.promises.writeFile(dbPath, dbBuffer);

      const tracks = parseDatabaseSync(dbPath);

      expect(tracks.length).toBe(1);
      expect(tracks[0].title).toBe('Sync Test');
    });
  });

  describe('getLibraryTracks', () => {
    it('returns empty array when database does not exist', async () => {
      const tracks = await getLibraryTracks(tempDir);
      expect(tracks).toEqual([]);
    });

    it('returns all tracks from database', async () => {
      const track1 = createTrack([
        pathField('pfil', '/track1.mp3'),
        textField('tsng', 'Track 1'),
      ]);
      const track2 = createTrack([
        pathField('pfil', '/track2.mp3'),
        textField('tsng', 'Track 2'),
      ]);

      const dbBuffer = createDatabaseBuffer([track1, track2]);
      await fs.promises.writeFile(path.join(tempDir, 'database V2'), dbBuffer);

      const tracks = await getLibraryTracks(tempDir);

      expect(tracks.length).toBe(2);
    });
  });

  describe('getTrackByPath', () => {
    beforeEach(async () => {
      const track = createTrack([
        pathField('pfil', '/Users/dj/Music/mytrack.mp3'),
        textField('tsng', 'My Track'),
        textField('tart', 'My Artist'),
      ]);

      const dbBuffer = createDatabaseBuffer([track]);
      await fs.promises.writeFile(path.join(tempDir, 'database V2'), dbBuffer);
    });

    it('finds track by exact path', async () => {
      const track = await getTrackByPath(tempDir, '/Users/dj/Music/mytrack.mp3');

      expect(track).toBeDefined();
      expect(track!.title).toBe('My Track');
    });

    it('returns undefined for non-existent path', async () => {
      const track = await getTrackByPath(tempDir, '/nonexistent.mp3');

      expect(track).toBeUndefined();
    });
  });

  describe('searchLibrary', () => {
    beforeEach(async () => {
      const tracks = [
        createTrack([
          pathField('pfil', '/house/deep.mp3'),
          textField('tsng', 'Deep House Track'),
          textField('tart', 'House Artist'),
          textField('talb', 'House Album'),
        ]),
        createTrack([
          pathField('pfil', '/techno/industrial.mp3'),
          textField('tsng', 'Industrial Beat'),
          textField('tart', 'Techno Producer'),
        ]),
        createTrack([
          pathField('pfil', '/house/funky.mp3'),
          textField('tsng', 'Funky House'),
          textField('tart', 'Another Artist'),
        ]),
      ];

      const dbBuffer = createDatabaseBuffer(tracks);
      await fs.promises.writeFile(path.join(tempDir, 'database V2'), dbBuffer);
    });

    it('searches by title', async () => {
      const results = await searchLibrary(tempDir, 'deep');

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Deep House Track');
    });

    it('searches by artist', async () => {
      const results = await searchLibrary(tempDir, 'producer');

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('Industrial Beat');
    });

    it('searches by album', async () => {
      const results = await searchLibrary(tempDir, 'album');

      expect(results.length).toBe(1);
      expect(results[0].album).toBe('House Album');
    });

    it('returns multiple matches', async () => {
      const results = await searchLibrary(tempDir, 'house');

      expect(results.length).toBe(2);
    });

    it('is case insensitive', async () => {
      const results = await searchLibrary(tempDir, 'HOUSE');

      expect(results.length).toBe(2);
    });

    it('returns empty array for no matches', async () => {
      const results = await searchLibrary(tempDir, 'nonexistent');

      expect(results).toEqual([]);
    });
  });

  describe('getDatabaseStats', () => {
    it('returns stats for library', async () => {
      const tracks = [
        createTrack([
          pathField('pfil', '/track1.mp3'),
          textField('tart', 'Artist A'),
          textField('tgen', 'House'),
          boolField('bbgl', true),
          boolField('bmis', false),
        ]),
        createTrack([
          pathField('pfil', '/track2.mp3'),
          textField('tart', 'Artist A'),
          textField('tgen', 'Techno'),
          boolField('bbgl', false),
          boolField('bmis', true),
        ]),
        createTrack([
          pathField('pfil', '/track3.mp3'),
          textField('tart', 'Artist B'),
          textField('tgen', 'House'),
          boolField('bbgl', true),
          boolField('bmis', false),
        ]),
      ];

      const dbBuffer = createDatabaseBuffer(tracks);
      await fs.promises.writeFile(path.join(tempDir, 'database V2'), dbBuffer);

      const stats = await getDatabaseStats(tempDir);

      expect(stats.totalTracks).toBe(3);
      expect(stats.missingTracks).toBe(1);
      expect(stats.lockedBeatgrids).toBe(2);
      expect(stats.artists).toBe(2);
      expect(stats.genres).toContain('House');
      expect(stats.genres).toContain('Techno');
      expect(stats.genres.length).toBe(2);
    });

    it('returns zero stats for empty database', async () => {
      const dbBuffer = createDatabaseBuffer([]);
      await fs.promises.writeFile(path.join(tempDir, 'database V2'), dbBuffer);

      const stats = await getDatabaseStats(tempDir);

      expect(stats.totalTracks).toBe(0);
      expect(stats.missingTracks).toBe(0);
      expect(stats.lockedBeatgrids).toBe(0);
      expect(stats.artists).toBe(0);
      expect(stats.genres).toEqual([]);
    });
  });
});
