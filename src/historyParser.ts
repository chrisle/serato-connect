/**
 * @fileoverview Serato history file parser.
 * Parses Serato's binary history format to extract played tracks.
 */

import { readFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { SeratoHistorySong, SeratoSession } from './types';

/**
 * Known chunk tags in Serato binary format
 */
export const CHUNK_TAGS = {
  /** Session container */
  OSES: 'oses',
  /** Entry container */
  OENT: 'oent',
  /** Track container */
  OTRK: 'otrk',
  /** Attribute data container */
  ADAT: 'adat',
  /** Index/ID field */
  INDEX: '\u0000\u0000\u0000\u0001',
  /** BPM field */
  BPM: '\u0000\u0000\u0000\u000f',
  /** Start time field */
  START_TIME: '\u0000\u0000\u0000\u001c',
  /** Deck field */
  DECK: '\u0000\u0000\u0000\u001f',
  /** Played field */
  PLAYED: '\u0000\u0000\u00002',
  /** Play time field */
  PLAY_TIME: '\u0000\u0000\u0000-',
  /** Title field */
  TITLE: '\u0000\u0000\u0000\u0006',
  /** Artist field */
  ARTIST: '\u0000\u0000\u0000\u0007',
  /** File path field */
  FILE_PATH: '\u0000\u0000\u0000\u0002',
  /** Session date field */
  SESSION_DATE: '\u0000\u0000\u0000)',
} as const;

interface Chunk {
  tag: string;
  length: number;
  data?: string | number | Date | Chunk[];
}

/**
 * Convert unsigned int to 4-byte string
 */
function getStringFromUInt32(n: number): string {
  return (
    String.fromCharCode(Math.floor(n / (1 << 24)) % 256) +
    String.fromCharCode(Math.floor(n / (1 << 16)) % 256) +
    String.fromCharCode(Math.floor(n / (1 << 8)) % 256) +
    String.fromCharCode(Math.floor(n) % 256)
  );
}

/**
 * Parse a single chunk from the Serato binary format
 */
async function parseChunk(
  buffer: Buffer,
  index: number
): Promise<{ chunk: Chunk; newIndex: number }> {
  const tag = getStringFromUInt32(buffer.readUInt32BE(index));
  const length = buffer.readUInt32BE(index + 4);
  let data: Chunk['data'];

  switch (tag) {
    case CHUNK_TAGS.OSES:
    case CHUNK_TAGS.OENT:
    case CHUNK_TAGS.OTRK:
    case CHUNK_TAGS.ADAT:
      data = await parseChunkArray(buffer, index + 8, index + 8 + length);
      break;

    case CHUNK_TAGS.INDEX:
    case CHUNK_TAGS.BPM:
      data = buffer.readUInt32BE(index + 8);
      break;

    case CHUNK_TAGS.START_TIME: {
      const seconds = buffer.readUInt32BE(index + 8);
      data = new Date(seconds * 1000);
      break;
    }

    case CHUNK_TAGS.DECK:
      data = buffer.readUInt32BE(index + 8);
      break;

    case CHUNK_TAGS.PLAYED:
      data = buffer.readUInt8(index + 8);
      break;

    case CHUNK_TAGS.PLAY_TIME: {
      const playtime = buffer.readUInt32BE(index + 8);
      data = new Date(playtime * 1000);
      break;
    }

    default:
      data = buffer
        .toString('latin1', index + 8, index + 8 + length)
        .replace(/\0/g, '');
      break;
  }

  return {
    chunk: { tag, length, data },
    newIndex: index + length + 8,
  };
}

/**
 * Parse array of chunks
 */
async function parseChunkArray(
  buffer: Buffer,
  start: number,
  end: number
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  let cursor = start;

  while (cursor < end) {
    const { chunk, newIndex } = await parseChunk(buffer, cursor);
    cursor = newIndex;
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Get sessions from history.database file
 */
export async function getSessions(historyDbPath: string): Promise<Map<string, number>> {
  const buffer = await readFile(historyDbPath);
  const chunks = await parseChunkArray(buffer, 0, buffer.length);
  const sessions = new Map<string, number>();

  for (const chunk of chunks) {
    if (chunk.tag === CHUNK_TAGS.OSES && Array.isArray(chunk.data)) {
      const adatChunk = chunk.data[0];
      if (adatChunk?.tag === CHUNK_TAGS.ADAT && Array.isArray(adatChunk.data)) {
        let date = '';
        let index = -1;

        for (const subChunk of adatChunk.data) {
          if (subChunk.tag === CHUNK_TAGS.INDEX) {
            index = subChunk.data as number;
          }
          if (subChunk.tag === CHUNK_TAGS.SESSION_DATE) {
            date = subChunk.data as string;
          }
        }

        if (date && index >= 0) {
          sessions.set(date, index);
        }
      }
    }
  }

  return sessions;
}

/**
 * Get songs from a session file
 */
export async function getSessionSongs(sessionPath: string): Promise<SeratoHistorySong[]> {
  const buffer = await readFile(sessionPath);
  const chunks = await parseChunkArray(buffer, 0, buffer.length);
  const songs: SeratoHistorySong[] = [];

  for (const chunk of chunks) {
    if (chunk.tag === CHUNK_TAGS.OENT && Array.isArray(chunk.data)) {
      const adatChunk = chunk.data[0];
      if (adatChunk?.tag === CHUNK_TAGS.ADAT && Array.isArray(adatChunk.data)) {
        let title = '';
        let artist = '';
        let bpm: number | undefined;
        let filePath = '';
        let startTime: Date | undefined;
        let playTime: Date | undefined;
        let played: number | undefined;
        let deck = 0;

        for (const subChunk of adatChunk.data) {
          switch (subChunk.tag) {
            case CHUNK_TAGS.TITLE:
              title = subChunk.data as string;
              break;
            case CHUNK_TAGS.ARTIST:
              artist = subChunk.data as string;
              break;
            case CHUNK_TAGS.BPM:
              bpm = subChunk.data as number;
              break;
            case CHUNK_TAGS.FILE_PATH:
              filePath = subChunk.data as string;
              break;
            case CHUNK_TAGS.START_TIME:
              startTime = subChunk.data as Date;
              break;
            case CHUNK_TAGS.PLAYED:
              played = subChunk.data as number;
              break;
            case CHUNK_TAGS.DECK:
              deck = subChunk.data as number;
              break;
            case CHUNK_TAGS.PLAY_TIME:
              playTime = subChunk.data as Date;
              break;
          }
        }

        const playing = played ? (startTime !== undefined && playTime === undefined) : false;

        songs.push({
          title,
          artist,
          bpm,
          filePath,
          startTime,
          playTime,
          played: !!played,
          playing,
          deck,
        });
      }
    }
  }

  return songs;
}

/**
 * Get all Serato history sessions
 */
export async function getSeratoHistory(seratoPath: string): Promise<SeratoSession[]> {
  const historyDbPath = join(seratoPath, 'History', 'history.database');
  if (!existsSync(historyDbPath)) {
    return [];
  }

  const sessionsMap = await getSessions(historyDbPath);
  const result: SeratoSession[] = [];

  for (const [date, index] of sessionsMap) {
    const sessionPath = join(seratoPath, 'History', 'Sessions', `${index}.session`);
    if (existsSync(sessionPath)) {
      const songs = await getSessionSongs(sessionPath);
      result.push({ date, index, songs });
    }
  }

  return result;
}

/**
 * Get the latest session file path
 */
export function getLatestSessionPath(seratoPath: string): string | null {
  const sessionsDir = join(seratoPath, 'History', 'Sessions');
  if (!existsSync(sessionsDir)) {
    return null;
  }

  const files = readdirSync(sessionsDir)
    .filter(f => f.endsWith('.session'))
    .map(f => ({
      name: f,
      index: parseInt(f.replace('.session', ''), 10),
    }))
    .filter(f => !isNaN(f.index))
    .sort((a, b) => b.index - a.index);

  if (files.length === 0) {
    return null;
  }

  return join(sessionsDir, files[0].name);
}
