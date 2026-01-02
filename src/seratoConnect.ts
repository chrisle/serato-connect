/**
 * @fileoverview SeratoConnect - Event-based Serato DJ history reader.
 * Monitors Serato history files and emits events when tracks change.
 */

import EventEmitter from 'node:events';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  getSeratoHistory,
  getSessionSongs,
  getLatestSessionPath,
} from './historyParser.js';
import {
  getAllCrates,
  parseCrate,
  listCrates,
  findCratesForTrack as findCratesForTrackParser,
  getLibraryTracks as getLibraryTracksParser,
  getTrackByPath as getTrackByPathParser,
  searchLibrary as searchLibraryParser,
  getDatabaseStats as getDatabaseStatsParser,
  type SeratoCrate,
  type SeratoDatabaseTrack,
} from './parsers/index.js';
import { getTrackMetadata as getTrackMetadataReader } from './readers/index.js';
import type {
  SeratoConnectOptions,
  SeratoHistorySong,
  SeratoTrackMetadata,
  TypedEmitter,
} from './types.js';

const DEFAULT_OPTIONS: Required<Omit<SeratoConnectOptions, 'seratoPath'>> = {
  pollIntervalMs: 2000,
  historyMaxRows: 100,
};

interface DeckState {
  song: SeratoHistorySong | null;
  playing: boolean;
}

/**
 * Get the default path to the _Serato_ folder based on platform
 */
export function getDefaultSeratoPath(): string {
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'win32') {
    return join(homedir(), 'Music', '_Serato_');
  }
  // Linux - less common but possible
  return join(homedir(), 'Music', '_Serato_');
}

/**
 * Detect if Serato is installed by checking for the _Serato_ folder
 */
export function detectSeratoInstallation(customPath?: string): {
  found: boolean;
  path: string;
  hasHistory: boolean;
} {
  const seratoPath = customPath || getDefaultSeratoPath();
  const found = existsSync(seratoPath);
  const hasHistory = found && existsSync(join(seratoPath, 'History'));

  return { found, path: seratoPath, hasHistory };
}

/**
 * SeratoConnect monitors Serato DJ history files and emits events
 * when tracks change or new history entries are detected.
 */
export class SeratoConnect extends (EventEmitter as new () => TypedEmitter) {
  private options: Required<Omit<SeratoConnectOptions, 'seratoPath'>> & { seratoPath: string };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private decks: DeckState[] = [];
  private lastTrackHash: string = '';
  private lastSessionMtime: number = 0;
  private lastSessionPath: string | null = null;
  private isRunning: boolean = false;

  constructor(options: SeratoConnectOptions = {}) {
    super();
    this.options = {
      ...DEFAULT_OPTIONS,
      seratoPath: options.seratoPath || getDefaultSeratoPath(),
      ...options,
    };

    // Initialize 4 deck states
    for (let i = 0; i < 4; i++) {
      this.decks.push({ song: null, playing: false });
    }
  }

  /**
   * Start monitoring Serato history files
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    const detection = detectSeratoInstallation(this.options.seratoPath);
    if (!detection.found) {
      this.emit('error', new Error(`Serato folder not found at: ${this.options.seratoPath}`));
      return;
    }

    if (!detection.hasHistory) {
      this.emit('error', new Error(`Serato History folder not found at: ${this.options.seratoPath}/History`));
      return;
    }

    this.isRunning = true;

    // Load initial history
    const history = await getSeratoHistory(this.options.seratoPath);

    // Emit ready event
    this.emit('ready', {
      seratoPath: this.options.seratoPath,
      sessionCount: history.length,
    });

    // Get latest session for initial state
    this.lastSessionPath = getLatestSessionPath(this.options.seratoPath);
    if (this.lastSessionPath && existsSync(this.lastSessionPath)) {
      const stat = statSync(this.lastSessionPath);
      this.lastSessionMtime = stat.mtimeMs;

      // Load initial deck states
      const songs = await getSessionSongs(this.lastSessionPath);
      this.updateDeckStates(songs);

      // Get currently playing track (if any)
      const nowPlaying = this.getNowPlaying();
      if (nowPlaying) {
        this.lastTrackHash = this.hashTrack(nowPlaying);
        this.emit('track', { track: nowPlaying, deckId: nowPlaying.deck });
      }
    }

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this.options.pollIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.isRunning = false;
    this.lastTrackHash = '';
    this.lastSessionMtime = 0;
    this.lastSessionPath = null;

    // Reset deck states
    for (let i = 0; i < 4; i++) {
      this.decks[i] = { song: null, playing: false };
    }
  }

  /**
   * Check if currently running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the currently playing track
   */
  getNowPlaying(): SeratoHistorySong | null {
    // Find decks that are playing
    const playingDecks = this.decks.filter(d => d.playing && d.song);

    if (playingDecks.length === 0) {
      return null;
    }

    if (playingDecks.length === 1) {
      return playingDecks[0].song;
    }

    // Multiple decks playing - return the one that started first (oldest)
    playingDecks.sort((a, b) => {
      const aTime = a.song?.startTime?.getTime() || 0;
      const bTime = b.song?.startTime?.getTime() || 0;
      return aTime - bTime;
    });

    return playingDecks[0].song;
  }

  /**
   * Get all deck states
   */
  getDeckStates(): readonly DeckState[] {
    return this.decks;
  }

  /**
   * Poll for changes
   */
  private async poll(): Promise<void> {
    try {
      this.emit('poll');

      // Check for new session file
      const currentSessionPath = getLatestSessionPath(this.options.seratoPath);
      if (!currentSessionPath || !existsSync(currentSessionPath)) {
        return;
      }

      const stat = statSync(currentSessionPath);
      const currentMtime = stat.mtimeMs;

      // Check if session file changed
      if (currentSessionPath !== this.lastSessionPath || currentMtime !== this.lastSessionMtime) {
        // Session changed or updated
        const isNewSession = currentSessionPath !== this.lastSessionPath;
        this.lastSessionPath = currentSessionPath;
        this.lastSessionMtime = currentMtime;

        // Parse the session
        const songs = await getSessionSongs(currentSessionPath);
        this.updateDeckStates(songs);

        // Check for track change
        const nowPlaying = this.getNowPlaying();
        if (nowPlaying) {
          const trackHash = this.hashTrack(nowPlaying);
          if (trackHash !== this.lastTrackHash) {
            this.lastTrackHash = trackHash;
            this.emit('track', { track: nowPlaying, deckId: nowPlaying.deck });
          }
        }

        // Emit history for new tracks
        if (songs.length > 0) {
          this.emit('history', {
            seratoPath: this.options.seratoPath,
            count: songs.length,
            tracks: songs.slice(-this.options.historyMaxRows),
          });
        }

        // Emit session event if it's a new session
        if (isNewSession) {
          // Extract session info from path
          const sessionIndex = parseInt(
            currentSessionPath.split('/').pop()?.replace('.session', '') || '0',
            10
          );
          this.emit('session', {
            session: {
              date: new Date().toISOString().split('T')[0],
              index: sessionIndex,
              songs,
            },
          });
        }
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Update internal deck states from session songs
   */
  private updateDeckStates(songs: SeratoHistorySong[]): void {
    for (const song of songs) {
      if (song.deck && song.deck >= 1 && song.deck <= 4) {
        const playing = song.startTime !== undefined && song.playTime === undefined;
        this.decks[song.deck - 1] = {
          song,
          playing,
        };
      }
    }
  }

  /**
   * Create a hash for a track to detect changes
   */
  private hashTrack(track: SeratoHistorySong): string {
    return `${track.artist}|${track.title}|${track.startTime?.getTime() || 0}`;
  }

  // ============================================================================
  // Library Access Methods
  // ============================================================================

  /**
   * Get Serato metadata from an audio file.
   *
   * Reads cue points, loops, beatgrid, colors, and other metadata
   * that Serato stores in the audio file's tags.
   *
   * @param filePath - Path to the audio file
   * @returns Parsed metadata, or null if not found
   */
  async getTrackMetadata(filePath: string): Promise<SeratoTrackMetadata | null> {
    return getTrackMetadataReader(filePath);
  }

  /**
   * Get all crates from the Serato library.
   *
   * @returns Array of crate objects with names and track paths
   */
  async getCrates(): Promise<SeratoCrate[]> {
    return getAllCrates(this.options.seratoPath);
  }

  /**
   * Get a specific crate by name.
   *
   * @param name - Name of the crate
   * @returns Crate object, or undefined if not found
   */
  async getCrate(name: string): Promise<SeratoCrate | undefined> {
    const crates = await listCrates(this.options.seratoPath);
    const cratePath = crates.find(p => p.endsWith(`${name}.crate`));
    if (!cratePath) {
      return undefined;
    }
    return parseCrate(cratePath);
  }

  /**
   * Find which crates contain a given track.
   *
   * @param trackPath - Path to the track file
   * @returns Array of crate names
   */
  async findCratesForTrack(trackPath: string): Promise<string[]> {
    return findCratesForTrackParser(this.options.seratoPath, trackPath);
  }

  /**
   * Get all tracks from the Serato library database.
   *
   * @param options - Query options
   * @returns Array of track entries
   */
  async getLibraryTracks(options?: {
    limit?: number;
    offset?: number;
  }): Promise<SeratoDatabaseTrack[]> {
    const tracks = await getLibraryTracksParser(this.options.seratoPath);
    if (!options?.limit && !options?.offset) {
      return tracks;
    }
    const start = options.offset || 0;
    const end = options.limit ? start + options.limit : tracks.length;
    return tracks.slice(start, end);
  }

  /**
   * Find a track in the library by file path.
   *
   * @param filePath - Path to the track file
   * @returns Track entry, or undefined if not found
   */
  async getTrackByPath(filePath: string): Promise<SeratoDatabaseTrack | undefined> {
    return getTrackByPathParser(this.options.seratoPath, filePath);
  }

  /**
   * Search the library for tracks matching a query.
   *
   * Searches title, artist, album, and file path.
   *
   * @param query - Search query string
   * @returns Array of matching track entries
   */
  async searchLibrary(query: string): Promise<SeratoDatabaseTrack[]> {
    return searchLibraryParser(this.options.seratoPath, query);
  }

  /**
   * Get statistics about the Serato library.
   *
   * @returns Library statistics
   */
  async getDatabaseStats(): Promise<{
    totalTracks: number;
    missingTracks: number;
    lockedBeatgrids: number;
    genres: string[];
    artists: number;
  }> {
    return getDatabaseStatsParser(this.options.seratoPath);
  }
}
