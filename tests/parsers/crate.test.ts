/**
 * Tests for Serato crate parser.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseCrate,
  parseCrateSync,
  listCrates,
  getAllCrates,
} from '../../src/parsers/crate.js';

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
 * Create a crate file buffer with the given track paths.
 */
function createCrateBuffer(version: string, trackPaths: string[]): Buffer {
  const chunks: Buffer[] = [];

  // Version chunk
  const versionData = utf16BE(version);
  const versionChunk = Buffer.concat([
    Buffer.from('vrsn'),
    Buffer.alloc(4),
    versionData,
  ]);
  versionChunk.writeUInt32BE(versionData.length, 4);
  chunks.push(versionChunk);

  // Track chunks
  for (const trackPath of trackPaths) {
    const pathData = utf16BE(trackPath);

    // ptrk chunk (inside otrk)
    const ptrkChunk = Buffer.concat([
      Buffer.from('ptrk'),
      Buffer.alloc(4),
      pathData,
    ]);
    ptrkChunk.writeUInt32BE(pathData.length, 4);

    // otrk wrapper
    const otrkChunk = Buffer.concat([
      Buffer.from('otrk'),
      Buffer.alloc(4),
      ptrkChunk,
    ]);
    otrkChunk.writeUInt32BE(ptrkChunk.length, 4);

    chunks.push(otrkChunk);
  }

  return Buffer.concat(chunks);
}

describe('Crate parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serato-crate-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('parseCrate', () => {
    it('parses crate file with version and tracks', async () => {
      const crateBuffer = createCrateBuffer('1.0/Serato ScratchLive Crate', [
        '/Users/dj/Music/track1.mp3',
        '/Users/dj/Music/track2.mp3',
      ]);

      const cratePath = path.join(tempDir, 'TestCrate.crate');
      await fs.promises.writeFile(cratePath, crateBuffer);

      const crate = await parseCrate(cratePath);

      expect(crate.name).toBe('TestCrate');
      expect(crate.path).toBe(cratePath);
      expect(crate.version).toBe('1.0/Serato ScratchLive Crate');
      expect(crate.trackPaths).toEqual([
        '/Users/dj/Music/track1.mp3',
        '/Users/dj/Music/track2.mp3',
      ]);
    });

    it('parses crate with no tracks', async () => {
      const crateBuffer = createCrateBuffer('1.0/Serato ScratchLive Crate', []);

      const cratePath = path.join(tempDir, 'Empty.crate');
      await fs.promises.writeFile(cratePath, crateBuffer);

      const crate = await parseCrate(cratePath);

      expect(crate.name).toBe('Empty');
      expect(crate.trackPaths).toEqual([]);
    });

    it('extracts crate name from filename', async () => {
      const crateBuffer = createCrateBuffer('1.0', []);

      const cratePath = path.join(tempDir, 'My Favorite Tracks.crate');
      await fs.promises.writeFile(cratePath, crateBuffer);

      const crate = await parseCrate(cratePath);

      expect(crate.name).toBe('My Favorite Tracks');
    });
  });

  describe('parseCrateSync', () => {
    it('parses crate file synchronously', async () => {
      const crateBuffer = createCrateBuffer('1.0', [
        '/path/to/track.mp3',
      ]);

      const cratePath = path.join(tempDir, 'SyncTest.crate');
      await fs.promises.writeFile(cratePath, crateBuffer);

      const crate = parseCrateSync(cratePath);

      expect(crate.name).toBe('SyncTest');
      expect(crate.trackPaths.length).toBe(1);
    });
  });

  describe('listCrates', () => {
    it('returns empty array when Subcrates folder does not exist', async () => {
      const crates = await listCrates(tempDir);
      expect(crates).toEqual([]);
    });

    it('lists crate files in Subcrates folder', async () => {
      const subcratesDir = path.join(tempDir, 'Subcrates');
      await fs.promises.mkdir(subcratesDir);

      await fs.promises.writeFile(
        path.join(subcratesDir, 'Crate1.crate'),
        createCrateBuffer('1.0', [])
      );
      await fs.promises.writeFile(
        path.join(subcratesDir, 'Crate2.crate'),
        createCrateBuffer('1.0', [])
      );
      await fs.promises.writeFile(
        path.join(subcratesDir, 'notacrate.txt'),
        'ignored'
      );

      const crates = await listCrates(tempDir);

      expect(crates.length).toBe(2);
      expect(crates[0]).toContain('Crate1.crate');
      expect(crates[1]).toContain('Crate2.crate');
    });

    it('returns sorted list', async () => {
      const subcratesDir = path.join(tempDir, 'Subcrates');
      await fs.promises.mkdir(subcratesDir);

      await fs.promises.writeFile(
        path.join(subcratesDir, 'Zebra.crate'),
        createCrateBuffer('1.0', [])
      );
      await fs.promises.writeFile(
        path.join(subcratesDir, 'Alpha.crate'),
        createCrateBuffer('1.0', [])
      );

      const crates = await listCrates(tempDir);

      expect(crates[0]).toContain('Alpha.crate');
      expect(crates[1]).toContain('Zebra.crate');
    });
  });

  describe('getAllCrates', () => {
    it('returns empty array when no crates exist', async () => {
      const crates = await getAllCrates(tempDir);
      expect(crates).toEqual([]);
    });

    it('returns parsed crate objects', async () => {
      const subcratesDir = path.join(tempDir, 'Subcrates');
      await fs.promises.mkdir(subcratesDir);

      await fs.promises.writeFile(
        path.join(subcratesDir, 'House.crate'),
        createCrateBuffer('1.0', ['/path/to/house1.mp3', '/path/to/house2.mp3'])
      );
      await fs.promises.writeFile(
        path.join(subcratesDir, 'Techno.crate'),
        createCrateBuffer('1.0', ['/path/to/techno1.mp3'])
      );

      const crates = await getAllCrates(tempDir);

      expect(crates.length).toBe(2);

      const house = crates.find(c => c.name === 'House');
      expect(house).toBeDefined();
      expect(house!.trackPaths.length).toBe(2);

      const techno = crates.find(c => c.name === 'Techno');
      expect(techno).toBeDefined();
      expect(techno!.trackPaths.length).toBe(1);
    });

    it('handles crate files with no tracks gracefully', async () => {
      const subcratesDir = path.join(tempDir, 'Subcrates');
      await fs.promises.mkdir(subcratesDir);

      // Valid crate
      await fs.promises.writeFile(
        path.join(subcratesDir, 'Valid.crate'),
        createCrateBuffer('1.0', ['/path/to/track.mp3'])
      );

      // Crate with malformed/empty data (parses but no tracks)
      await fs.promises.writeFile(
        path.join(subcratesDir, 'Empty.crate'),
        Buffer.from([0x00, 0x01, 0x02]) // Invalid data, parses as empty
      );

      const crates = await getAllCrates(tempDir);

      // Both should be returned
      expect(crates.length).toBe(2);

      const valid = crates.find(c => c.name === 'Valid');
      expect(valid).toBeDefined();
      expect(valid!.trackPaths.length).toBe(1);

      const empty = crates.find(c => c.name === 'Empty');
      expect(empty).toBeDefined();
      expect(empty!.trackPaths.length).toBe(0);
    });
  });
});
