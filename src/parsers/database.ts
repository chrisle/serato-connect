/**
 * Parse Serato Database V2 files.
 *
 * The database file contains the full track library with metadata.
 * Located at: _Serato_/database V2
 *
 * The format uses a DOM-like structure with 4-byte tags and 4-byte lengths.
 * The first character of the tag indicates the data type.
 *
 * Format documentation and parsing algorithm based on:
 * - Mixxx Wiki: https://github.com/mixxxdj/mixxx/wiki/Serato-Database-Format
 * - serato-tags by @Holzhaus: https://github.com/Holzhaus/serato-tags
 *   Source: https://github.com/Holzhaus/serato-tags/blob/main/scripts/database_v2.py
 * - seratoparser by @SpinTools: https://github.com/SpinTools/seratoparser
 *
 * @module parsers/database
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A track entry from the Serato database.
 */
export interface SeratoDatabaseTrack {
  /** Full file path to the track */
  filePath: string;
  /** Track title */
  title?: string;
  /** Track artist */
  artist?: string;
  /** Album name */
  album?: string;
  /** Track genre */
  genre?: string;
  /** Musical key */
  key?: string;
  /** BPM value */
  bpm?: number;
  /** Track length in seconds */
  length?: number;
  /** Bitrate in kbps */
  bitrate?: number;
  /** Sample rate in Hz */
  sampleRate?: number;
  /** File type (e.g., 'mp3', 'flac') */
  fileType?: string;
  /** Whether the beatgrid is locked */
  beatgridLocked?: boolean;
  /** Whether the file is missing */
  missing?: boolean;
  /** Date added to library */
  dateAdded?: Date;
  /** Comment field */
  comment?: string;
  /** Grouping field */
  grouping?: string;
  /** Composer */
  composer?: string;
  /** Label/Publisher */
  label?: string;
  /** Year */
  year?: number;
}

/**
 * Field name mappings for database tags (for reference).
 * From serato-tags database_v2.py
 *
 * Tags and their meanings:
 * - vrsn: version
 * - otrk: track container
 * - ttyp: file type
 * - pfil: file path
 * - tsng: song title
 * - tart: artist
 * - talb: album
 * - tgen: genre
 * - tkey: musical key
 * - tbpm: BPM
 * - tlen: track length
 * - tbit: bitrate
 * - tsmp: sample rate
 * - bbgl: beatgrid locked
 * - bmis: file missing
 * - uadd: date added (unix timestamp)
 * - tcom: comment
 * - tgrp: grouping
 * - tcmp: composer
 * - tlbl: label
 * - ttyr: year
 * - utme: file time
 */

/**
 * Read a UTF-16 BE encoded string from buffer.
 */
function readUtf16BE(buffer: Buffer, offset: number, length: number): string {
  if (length < 2) return '';
  const bytes = buffer.subarray(offset, offset + length);
  // Swap bytes for Node's UTF-16 LE decoder
  const swapped = Buffer.alloc(length);
  for (let i = 0; i < length; i += 2) {
    if (i + 1 < length) {
      swapped[i] = bytes[i + 1];
      swapped[i + 1] = bytes[i];
    }
  }
  return swapped.toString('utf16le').replace(/\0/g, '');
}

/**
 * Parse a field value based on its type prefix.
 */
function parseFieldValue(
  tag: string,
  data: Buffer
): string | number | boolean | Buffer | null {
  if (data.length === 0) return null;

  const typeChar = tag[0];

  switch (typeChar) {
    case 't': // Text (UTF-16 BE)
    case 'p': // Path (UTF-16 BE)
      return readUtf16BE(data, 0, data.length);

    case 'b': // Boolean (1 byte)
      return data[0] !== 0;

    case 'u': // Unsigned 32-bit integer
      if (data.length >= 4) {
        return data.readUInt32BE(0);
      }
      return null;

    case 's': // Signed/short integer (2 bytes)
      if (data.length >= 2) {
        return data.readUInt16BE(0);
      }
      return null;

    case 'o': // Object/nested structure
    case 'r': // Record/nested structure
      return data; // Return raw buffer for further parsing

    default:
      // Unknown type, return raw buffer
      return data;
  }
}

/**
 * Parse a track entry from the database.
 */
function parseTrackEntry(data: Buffer): SeratoDatabaseTrack | null {
  const track: Partial<SeratoDatabaseTrack> = {};
  let offset = 0;

  while (offset + 8 <= data.length) {
    const tag = data.subarray(offset, offset + 4).toString('ascii');
    offset += 4;

    const length = data.readUInt32BE(offset);
    offset += 4;

    if (offset + length > data.length) {
      break;
    }

    const fieldData = data.subarray(offset, offset + length);
    offset += length;

    const value = parseFieldValue(tag, fieldData);
    if (value === null) continue;

    // Map to track fields
    switch (tag) {
      case 'pfil':
        track.filePath = value as string;
        break;
      case 'tsng':
        track.title = value as string;
        break;
      case 'tart':
        track.artist = value as string;
        break;
      case 'talb':
        track.album = value as string;
        break;
      case 'tgen':
        track.genre = value as string;
        break;
      case 'tkey':
        track.key = value as string;
        break;
      case 'tbpm':
        track.bpm = parseFloat(value as string) || undefined;
        break;
      case 'tlen':
        track.length = parseFloat(value as string) || undefined;
        break;
      case 'tbit':
        track.bitrate = parseInt(value as string, 10) || undefined;
        break;
      case 'tsmp':
        track.sampleRate = parseInt(value as string, 10) || undefined;
        break;
      case 'ttyp':
        track.fileType = value as string;
        break;
      case 'bbgl':
        track.beatgridLocked = value as boolean;
        break;
      case 'bmis':
        track.missing = value as boolean;
        break;
      case 'uadd':
        if (typeof value === 'number' && value > 0) {
          track.dateAdded = new Date(value * 1000);
        }
        break;
      case 'tcom':
        track.comment = value as string;
        break;
      case 'tgrp':
        track.grouping = value as string;
        break;
      case 'tcmp':
        track.composer = value as string;
        break;
      case 'tlbl':
        track.label = value as string;
        break;
      case 'ttyr':
        track.year = parseInt(value as string, 10) || undefined;
        break;
    }
  }

  if (!track.filePath) {
    return null;
  }

  return track as SeratoDatabaseTrack;
}

/**
 * Parse the Serato database V2 file.
 *
 * @param data - Raw database file data
 * @returns Array of track entries
 */
function parseDatabaseData(data: Buffer): SeratoDatabaseTrack[] {
  const tracks: SeratoDatabaseTrack[] = [];
  let offset = 0;

  while (offset + 8 <= data.length) {
    const tag = data.subarray(offset, offset + 4).toString('ascii');
    offset += 4;

    const length = data.readUInt32BE(offset);
    offset += 4;

    if (offset + length > data.length) {
      break;
    }

    if (tag === 'otrk') {
      // Track entry
      const trackData = data.subarray(offset, offset + length);
      const track = parseTrackEntry(trackData);
      if (track) {
        tracks.push(track);
      }
    }

    offset += length;
  }

  return tracks;
}

/**
 * Parse the Serato database V2 file from a path.
 *
 * @param databasePath - Path to the "database V2" file
 * @returns Array of track entries
 */
export async function parseDatabase(
  databasePath: string
): Promise<SeratoDatabaseTrack[]> {
  const data = await fs.promises.readFile(databasePath);
  return parseDatabaseData(data);
}

/**
 * Parse the Serato database V2 file synchronously.
 *
 * @param databasePath - Path to the "database V2" file
 * @returns Array of track entries
 */
export function parseDatabaseSync(databasePath: string): SeratoDatabaseTrack[] {
  const data = fs.readFileSync(databasePath);
  return parseDatabaseData(data);
}

/**
 * Get all tracks from a Serato installation's database.
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @returns Array of track entries
 */
export async function getLibraryTracks(
  seratoPath: string
): Promise<SeratoDatabaseTrack[]> {
  const databasePath = path.join(seratoPath, 'database V2');

  try {
    return await parseDatabase(databasePath);
  } catch {
    return [];
  }
}

/**
 * Find a track in the database by file path.
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @param filePath - File path to search for
 * @returns Track entry, or undefined if not found
 */
export async function getTrackByPath(
  seratoPath: string,
  filePath: string
): Promise<SeratoDatabaseTrack | undefined> {
  const tracks = await getLibraryTracks(seratoPath);
  const normalizedPath = path.normalize(filePath).toLowerCase();

  return tracks.find(t => {
    const trackPath = path.normalize(t.filePath).toLowerCase();
    return trackPath === normalizedPath || trackPath.endsWith(normalizedPath);
  });
}

/**
 * Search the library for tracks matching a query.
 *
 * Searches title, artist, album, and file path.
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @param query - Search query string
 * @returns Matching track entries
 */
export async function searchLibrary(
  seratoPath: string,
  query: string
): Promise<SeratoDatabaseTrack[]> {
  const tracks = await getLibraryTracks(seratoPath);
  const lowerQuery = query.toLowerCase();

  return tracks.filter(t => {
    const searchFields = [
      t.title,
      t.artist,
      t.album,
      t.filePath,
      t.genre,
      t.comment,
    ].filter(Boolean);

    return searchFields.some(field =>
      field!.toLowerCase().includes(lowerQuery)
    );
  });
}

/**
 * Get database statistics.
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @returns Statistics about the library
 */
export async function getDatabaseStats(seratoPath: string): Promise<{
  totalTracks: number;
  missingTracks: number;
  lockedBeatgrids: number;
  genres: string[];
  artists: number;
}> {
  const tracks = await getLibraryTracks(seratoPath);

  const genres = new Set<string>();
  const artists = new Set<string>();
  let missing = 0;
  let locked = 0;

  for (const track of tracks) {
    if (track.missing) missing++;
    if (track.beatgridLocked) locked++;
    if (track.genre) genres.add(track.genre);
    if (track.artist) artists.add(track.artist);
  }

  return {
    totalTracks: tracks.length,
    missingTracks: missing,
    lockedBeatgrids: locked,
    genres: Array.from(genres).sort(),
    artists: artists.size,
  };
}
