/**
 * @fileoverview Serato 4.0 history parser using SQLite database.
 * Serato 4.0 stores history in ~/Library/Application Support/Serato/Library/master.sqlite
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { SeratoHistorySong, SeratoSession } from './types.js';

// Debug tracing - enable with DEBUG_SERATO=1 environment variable
const DEBUG = process.env.DEBUG_SERATO === '1';
function debug(message: string, data?: unknown): void {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString().slice(11, 23);
  if (data !== undefined) {
    console.log(`[serato-v4-parser ${timestamp}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[serato-v4-parser ${timestamp}] ${message}`);
  }
}

/**
 * Get the default path to the Serato 4 Library folder.
 */
export function getDefaultSeratoV4LibraryPath(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Serato', 'Library');
  }
  if (platform === 'win32') {
    // Windows: %APPDATA%\Serato\Library (likely location)
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Serato', 'Library');
  }
  throw new Error('Serato DJ Pro is only supported on macOS and Windows');
}

/**
 * Get the path to the master.sqlite database.
 */
export function getMasterDatabasePath(libraryPath?: string): string {
  const basePath = libraryPath || getDefaultSeratoV4LibraryPath();
  return join(basePath, 'master.sqlite');
}

/**
 * Check if Serato 4 database exists.
 */
export function hasSeratoV4Database(libraryPath?: string): boolean {
  const dbPath = getMasterDatabasePath(libraryPath);
  return existsSync(dbPath);
}

/**
 * Raw history entry from SQLite database.
 */
interface RawHistoryEntry {
  id: number;
  session_id: number;
  name: string;
  artist: string;
  deck: string;
  start_time: number;
  end_time: number;
  played: number;
  bpm: number | null;
  file_name: string | null;
  portable_id: string;
}

/**
 * Raw session from SQLite database.
 */
interface RawSession {
  id: number;
  start_time: number;
  end_time: number | null;
  name: string | null;
}

/**
 * Get location mappings from the connection table.
 * This maps location_id to base paths for resolving full file paths.
 */
function getLocationMappings(db: Database.Database): Map<number, string> {
  const mappings = new Map<number, string>();

  try {
    const connections = db.prepare(`
      SELECT location_id, database_uri FROM connection
    `).all() as { location_id: number; database_uri: string }[];

    for (const conn of connections) {
      // Parse the database_uri to determine the base path
      // Examples:
      // - /Users/chrisle/Library/Application Support/Serato/Library/root.sqlite → portable_id is full path minus leading /
      // - /Volumes/SD/_Serato_/Library/location.sqlite → base path is /Volumes/SD/
      if (conn.database_uri.endsWith('/root.sqlite') || conn.database_uri.endsWith('/beatport.sqlite')) {
        // For root.sqlite and beatport.sqlite, portable_id is full path minus leading /
        mappings.set(conn.location_id, '/');
      } else if (conn.database_uri.includes('/_Serato_/Library/location.sqlite')) {
        // For external volumes, extract the volume path
        // /Volumes/SD/_Serato_/Library/location.sqlite → /Volumes/SD/
        const match = conn.database_uri.match(/^(.+)\/_Serato_\/Library\/location\.sqlite$/);
        if (match) {
          mappings.set(conn.location_id, match[1] + '/');
        }
      }
    }

    debug('getLocationMappings: resolved mappings', {
      mappings: Object.fromEntries(mappings),
    });
  } catch (err) {
    debug('getLocationMappings: error', { error: String(err) });
  }

  return mappings;
}

/**
 * Extended asset metadata including streaming service info.
 */
interface AssetMetadata {
  fullPath: string | null;
  artworkUrl?: string;
  streamingSource?: string;
  streamingId?: string;
  album?: string;
  label?: string;
  genre?: string;
  key?: string;
}

/**
 * Parse the type_specific_data JSON to extract artwork URL.
 */
function parseTypeSpecificData(data: string | null): { cover_id?: string } | null {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Parse streaming portable_id to extract source and ID.
 * Formats:
 *   - streaming://beatport/12345678
 *   - streaming://tidal/12345678
 *   - streaming://soundcloud/12345678
 *   - streaming://beatsource/12345678
 */
function parseStreamingId(portableId: string): { source: string; id: string } | null {
  const match = portableId.match(/^streaming:\/\/(\w+)\/(.+)$/);
  if (match) {
    return { source: match[1], id: match[2] };
  }
  return null;
}

/**
 * Resolve asset metadata for a history entry by looking up the asset.
 */
function resolveAssetMetadata(
  db: Database.Database,
  portableId: string,
  locationMappings: Map<number, string>
): AssetMetadata {
  const result: AssetMetadata = { fullPath: null };

  try {
    // Look up the asset by portable_id to get full metadata
    const asset = db.prepare(`
      SELECT location_id, portable_id, type_specific_data, album, label, genre, key
      FROM asset WHERE portable_id = ? LIMIT 1
    `).get(portableId) as {
      location_id: number;
      portable_id: string;
      type_specific_data: string | null;
      album: string | null;
      label: string | null;
      genre: string | null;
      key: string | null;
    } | undefined;

    if (!asset) {
      debug('resolveAssetMetadata: asset not found', { portableId });
      return result;
    }

    // Check if this is a streaming track
    const streamingInfo = parseStreamingId(portableId);
    if (streamingInfo) {
      result.streamingSource = streamingInfo.source;
      result.streamingId = streamingInfo.id;
      result.fullPath = portableId; // Use the streaming URL as the path

      // Extract artwork URL from type_specific_data
      const typeData = parseTypeSpecificData(asset.type_specific_data);
      if (typeData?.cover_id) {
        result.artworkUrl = typeData.cover_id;
      }

      debug('resolveAssetMetadata: streaming track', {
        portableId,
        streamingSource: result.streamingSource,
        streamingId: result.streamingId,
        artworkUrl: result.artworkUrl,
      });
    } else {
      // Regular file - resolve full path
      const basePath = locationMappings.get(asset.location_id);
      if (basePath) {
        result.fullPath = basePath + asset.portable_id;
        debug('resolveAssetMetadata: local file', { portableId, fullPath: result.fullPath });
      } else {
        debug('resolveAssetMetadata: no base path for location', {
          portableId,
          locationId: asset.location_id,
        });
      }
    }

    // Copy additional metadata
    if (asset.album) result.album = asset.album;
    if (asset.label) result.label = asset.label;
    if (asset.genre) result.genre = asset.genre;
    if (asset.key) result.key = asset.key;

    return result;
  } catch (err) {
    debug('resolveAssetMetadata: error', { portableId, error: String(err) });
    return result;
  }
}

/**
 * Convert raw SQLite entry to SeratoHistorySong.
 */
function entryToSong(
  entry: RawHistoryEntry,
  db?: Database.Database,
  locationMappings?: Map<number, string>
): SeratoHistorySong {
  let filePath = entry.file_name || entry.portable_id || '';
  let artworkUrl: string | undefined;
  let streamingSource: string | undefined;
  let streamingId: string | undefined;
  let album: string | undefined;
  let label: string | undefined;
  let genre: string | undefined;
  let key: string | undefined;

  // Try to resolve asset metadata if we have the database connection
  if (db && locationMappings && entry.portable_id) {
    const metadata = resolveAssetMetadata(db, entry.portable_id, locationMappings);
    if (metadata.fullPath) {
      filePath = metadata.fullPath;
    }
    artworkUrl = metadata.artworkUrl;
    streamingSource = metadata.streamingSource;
    streamingId = metadata.streamingId;
    album = metadata.album;
    label = metadata.label;
    genre = metadata.genre;
    key = metadata.key;
  }

  return {
    title: entry.name || '',
    artist: entry.artist || '',
    filePath,
    bpm: entry.bpm ?? undefined,
    startTime: entry.start_time > 0 ? new Date(entry.start_time * 1000) : undefined,
    playTime: entry.end_time > 0 ? new Date(entry.end_time * 1000) : undefined,
    played: entry.played === 1,
    deck: entry.deck ? parseInt(entry.deck, 10) : undefined,
    artworkUrl,
    streamingSource,
    streamingId,
    album,
    label,
    genre,
    key,
  };
}

/**
 * Get all sessions from Serato 4 database.
 */
export function getSeratoV4Sessions(libraryPath?: string): SeratoSession[] {
  const dbPath = getMasterDatabasePath(libraryPath);
  if (!existsSync(dbPath)) {
    return [];
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    // Get location mappings for resolving full file paths
    const locationMappings = getLocationMappings(db);

    const sessions = db.prepare(`
      SELECT id, start_time, end_time, name
      FROM history_session
      ORDER BY start_time DESC
    `).all() as RawSession[];

    return sessions.map((session) => {
      const entries = db.prepare(`
        SELECT id, session_id, name, artist, deck, start_time, end_time, played, bpm, file_name, portable_id
        FROM history_entry
        WHERE session_id = ?
        ORDER BY start_time ASC
      `).all(session.id) as RawHistoryEntry[];

      return {
        date: new Date(session.start_time * 1000).toISOString().split('T')[0],
        index: session.id,
        songs: entries.map((e) => entryToSong(e, db, locationMappings)),
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Get songs from the latest (current) session.
 */
export function getLatestSessionSongsV4(libraryPath?: string): SeratoHistorySong[] {
  const dbPath = getMasterDatabasePath(libraryPath);
  if (!existsSync(dbPath)) {
    return [];
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    // Get location mappings for resolving full file paths
    const locationMappings = getLocationMappings(db);

    // Debug: show all sessions
    const allSessions = db.prepare(`
      SELECT id, start_time, end_time, name
      FROM history_session
      ORDER BY start_time DESC
      LIMIT 5
    `).all() as RawSession[];

    debug('getLatestSessionSongsV4: all recent sessions', {
      sessions: allSessions.map((s) => ({
        id: s.id,
        start_time: s.start_time ? new Date(s.start_time * 1000).toISOString() : null,
        end_time: s.end_time ? new Date(s.end_time * 1000).toISOString() : null,
        name: s.name,
      })),
    });

    // Get the latest session
    const session = allSessions[0];

    if (!session) {
      return [];
    }

    debug('getLatestSessionSongsV4: using session', {
      sessionId: session.id,
      start_time: session.start_time ? new Date(session.start_time * 1000).toISOString() : null,
    });

    const entries = db.prepare(`
      SELECT id, session_id, name, artist, deck, start_time, end_time, played, bpm, file_name, portable_id
      FROM history_entry
      WHERE session_id = ?
      ORDER BY start_time ASC
    `).all(session.id) as RawHistoryEntry[];

    debug('getLatestSessionSongsV4: raw entries from database', {
      sessionId: session.id,
      entryCount: entries.length,
      entries: entries.map((e) => ({
        id: e.id,
        name: e.name,
        artist: e.artist,
        deck: e.deck,
        start_time: e.start_time,
        start_time_iso: e.start_time ? new Date(e.start_time * 1000).toISOString() : null,
        end_time: e.end_time,
        end_time_iso: e.end_time ? new Date(e.end_time * 1000).toISOString() : null,
        played: e.played,
        portable_id: e.portable_id,
      })),
    });

    return entries.map((e) => entryToSong(e, db, locationMappings));
  } finally {
    db.close();
  }
}

/**
 * Get the latest session info (for change detection).
 */
export function getLatestSessionInfoV4(libraryPath?: string): { id: number; entryCount: number } | null {
  const dbPath = getMasterDatabasePath(libraryPath);
  if (!existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const session = db.prepare(`
      SELECT id FROM history_session ORDER BY start_time DESC LIMIT 1
    `).get() as { id: number } | undefined;

    if (!session) {
      return null;
    }

    const countResult = db.prepare(`
      SELECT COUNT(*) as count FROM history_entry WHERE session_id = ?
    `).get(session.id) as { count: number };

    return {
      id: session.id,
      entryCount: countResult.count,
    };
  } finally {
    db.close();
  }
}

/**
 * Get the modification time of the database file.
 */
export function getDatabaseMtime(libraryPath?: string): number {
  const dbPath = getMasterDatabasePath(libraryPath);
  if (!existsSync(dbPath)) {
    return 0;
  }

  const { statSync } = require('fs');
  return statSync(dbPath).mtimeMs;
}
