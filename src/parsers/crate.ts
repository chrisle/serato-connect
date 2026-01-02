/**
 * Parse Serato crate files (.crate).
 *
 * Crate files contain references to tracks organized into collections.
 * The format uses a binary structure with 4-byte tags and lengths.
 *
 * Format documentation and parsing algorithm based on:
 * - Mixxx Wiki: https://github.com/mixxxdj/mixxx/wiki/serato_database_format
 * - seratoparser by @SpinTools: https://github.com/SpinTools/seratoparser
 *   Source: https://github.com/SpinTools/seratoparser/blob/master/internal/crate/crate.go
 *
 * @module parsers/crate
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Represents a parsed Serato crate.
 */
export interface SeratoCrate {
  /** Name of the crate (from filename) */
  name: string;
  /** Full path to the crate file */
  path: string;
  /** Version string from the crate file */
  version?: string;
  /** Track file paths (relative to drive root or absolute) */
  trackPaths: string[];
}

/**
 * Read a 4-byte big-endian unsigned integer.
 */
function readUInt32BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

/**
 * Read a UTF-16 BE encoded string.
 */
function readUtf16BE(buffer: Buffer, offset: number, length: number): string {
  // UTF-16 BE: each character is 2 bytes
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
 * Parse a crate file and extract track paths.
 *
 * Structure:
 * - Each record: 4-byte tag + 4-byte length (BE) + data
 * - vrsn: Version string (UTF-16 BE)
 * - otrk: Track container (nested records)
 * - ptrk: Track path (UTF-16 BE)
 *
 * @param data - Raw crate file data
 * @returns List of track paths
 */
function parseCrateData(data: Buffer): { version?: string; trackPaths: string[] } {
  const trackPaths: string[] = [];
  let version: string | undefined;
  let offset = 0;

  while (offset + 8 <= data.length) {
    // Read tag (4 bytes ASCII)
    const tag = data.subarray(offset, offset + 4).toString('ascii');
    offset += 4;

    // Read length (4 bytes BE)
    const length = readUInt32BE(data, offset);
    offset += 4;

    // Validate we have enough data
    if (offset + length > data.length) {
      break;
    }

    // Parse based on tag
    if (tag === 'vrsn') {
      // Version string
      version = readUtf16BE(data, offset, length);
    } else if (tag === 'otrk') {
      // Track container - parse nested records
      const trackData = data.subarray(offset, offset + length);
      let trackOffset = 0;

      while (trackOffset + 8 <= trackData.length) {
        const innerTag = trackData.subarray(trackOffset, trackOffset + 4).toString('ascii');
        trackOffset += 4;
        const innerLength = readUInt32BE(trackData, trackOffset);
        trackOffset += 4;

        if (trackOffset + innerLength > trackData.length) {
          break;
        }

        if (innerTag === 'ptrk') {
          // Track path
          const trackPath = readUtf16BE(trackData, trackOffset, innerLength);
          if (trackPath) {
            trackPaths.push(trackPath);
          }
        }

        trackOffset += innerLength;
      }
    }

    offset += length;
  }

  return { version, trackPaths };
}

/**
 * Parse a single crate file.
 *
 * @param cratePath - Path to the .crate file
 * @returns Parsed crate data
 */
export async function parseCrate(cratePath: string): Promise<SeratoCrate> {
  const data = await fs.promises.readFile(cratePath);
  const { version, trackPaths } = parseCrateData(data);

  // Crate name is derived from the filename
  const name = path.basename(cratePath, '.crate');

  return {
    name,
    path: cratePath,
    version,
    trackPaths,
  };
}

/**
 * Parse a crate file synchronously.
 *
 * @param cratePath - Path to the .crate file
 * @returns Parsed crate data
 */
export function parseCrateSync(cratePath: string): SeratoCrate {
  const data = fs.readFileSync(cratePath);
  const { version, trackPaths } = parseCrateData(data);

  const name = path.basename(cratePath, '.crate');

  return {
    name,
    path: cratePath,
    version,
    trackPaths,
  };
}

/**
 * List all crate files in a Serato folder.
 *
 * Crates are stored in _Serato_/Subcrates/*.crate
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @returns List of crate file paths
 */
export async function listCrates(seratoPath: string): Promise<string[]> {
  const cratesDir = path.join(seratoPath, 'Subcrates');

  try {
    const entries = await fs.promises.readdir(cratesDir);
    return entries
      .filter(f => f.endsWith('.crate'))
      .map(f => path.join(cratesDir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Get all crates from a Serato installation.
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @returns Array of parsed crates
 */
export async function getAllCrates(seratoPath: string): Promise<SeratoCrate[]> {
  const cratePaths = await listCrates(seratoPath);
  const crates: SeratoCrate[] = [];

  for (const cratePath of cratePaths) {
    try {
      const crate = await parseCrate(cratePath);
      crates.push(crate);
    } catch {
      // Skip unreadable crates
    }
  }

  return crates;
}

/**
 * Find which crates contain a given track.
 *
 * @param seratoPath - Path to the _Serato_ folder
 * @param trackPath - Path to the track file
 * @returns Array of crate names containing the track
 */
export async function findCratesForTrack(
  seratoPath: string,
  trackPath: string
): Promise<string[]> {
  const crates = await getAllCrates(seratoPath);
  const matches: string[] = [];

  // Normalize the track path for comparison
  const normalizedTrackPath = path.normalize(trackPath).toLowerCase();

  for (const crate of crates) {
    for (const crateTrackPath of crate.trackPaths) {
      // Crate paths may be relative to drive root, so check if they match
      const normalizedCratePath = path.normalize(crateTrackPath).toLowerCase();
      if (
        normalizedTrackPath === normalizedCratePath ||
        normalizedTrackPath.endsWith(normalizedCratePath) ||
        normalizedCratePath.endsWith(normalizedTrackPath.split(path.sep).slice(-3).join(path.sep))
      ) {
        matches.push(crate.name);
        break;
      }
    }
  }

  return matches;
}
