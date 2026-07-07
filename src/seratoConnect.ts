/**
 * @fileoverview SeratoConnect - Event-based Serato DJ history reader.
 * Monitors Serato history files and emits events when tracks change.
 * Supports both Serato 3 (binary format) and Serato 4 (SQLite database).
 */

import EventEmitter from 'node:events';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { type Logger, noopLogger } from './types/logger.js';
import {
  getSeratoHistory,
  getSessionSongs,
  getLatestSessionPath,
} from './historyParser.js';
import {
  getDefaultSeratoV4LibraryPath,
  hasSeratoV4Database,
  getSeratoV4Sessions,
  getLatestSessionSongsV4,
  getLatestSessionInfoV4,
  getDatabaseMtime,
} from './historyParserV4.js';
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
  SeratoVersion,
  TypedEmitter,
} from './types.js';

const DEFAULT_OPTIONS: Required<Omit<SeratoConnectOptions, 'seratoPath' | 'forceVersion' | 'logger'>> = {
  pollIntervalMs: 2000,
  historyMaxRows: 100,
};

/** Number of decks to track (Serato supports up to 4) */
const NUM_DECKS = 4;

/**
 * Get the default path to the _Serato_ folder based on platform (v3).
 *
 * Note: Serato DJ Pro only supports macOS and Windows.
 */
export function getDefaultSeratoPath(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return join(homedir(), 'Music', '_Serato_');
  }
  if (platform === 'win32') {
    return join(homedir(), 'Music', '_Serato_');
  }
  // Serato DJ Pro does not support Linux
  throw new Error('Serato DJ Pro is only supported on macOS and Windows');
}

/**
 * Detect which version of Serato is installed.
 * If a custom path is provided, only checks for v3 at that path.
 * Otherwise, checks for both v4 (SQLite) and v3 (binary History).
 * When both exist, compares modification times to determine which is actively in use.
 */
export function detectSeratoVersion(seratoV3Path?: string): SeratoVersion {
  // If custom path provided, only check for v3 at that location
  if (seratoV3Path) {
    if (existsSync(seratoV3Path) && existsSync(join(seratoV3Path, 'History'))) {
      return 'v3';
    }
    return 'unknown';
  }

  const hasV4 = hasSeratoV4Database();
  const v3Path = getDefaultSeratoPath();
  const hasV3 = existsSync(v3Path) && existsSync(join(v3Path, 'History'));

  // Both exist — compare modification times to pick the actively used one
  if (hasV4 && hasV3) {
    const v4Mtime = getDatabaseMtime();
    const v3HistoryPath = join(v3Path, 'History');
    const v3Mtime = statSync(v3HistoryPath).mtimeMs;

    return v3Mtime > v4Mtime ? 'v3' : 'v4';
  }

  if (hasV4) return 'v4';
  if (hasV3) return 'v3';

  return 'unknown';
}

/**
 * Detect if Serato is installed by checking for the _Serato_ folder or SQLite database.
 * Supports both Serato 3 (binary format) and Serato 4 (SQLite database).
 * If a custom path is provided, only checks that path for v3 format.
 *
 * @param customPath - User-configured custom path to the _Serato_ folder. When provided,
 *   only this path is checked (v4 detection is skipped).
 * @param additionalV3Paths - Extra candidate paths to check for v3 when auto-detecting.
 *   Useful on Windows where the Music folder may be redirected (e.g., via OneDrive).
 *   Checked in order after the default v3 path.
 */
export function detectSeratoInstallation(
  customPath?: string,
  additionalV3Paths?: string[]
): {
  found: boolean;
  path: string;
  hasHistory: boolean;
  version: SeratoVersion;
} {
  // If custom path provided, only check for v3 at that location
  if (customPath) {
    const found = existsSync(customPath);
    const hasHistory = found && existsSync(join(customPath, 'History'));
    return {
      found,
      path: customPath,
      hasHistory,
      version: found && hasHistory ? 'v3' : 'unknown',
    };
  }

  // No custom path - use detectSeratoVersion which handles mtime comparison
  const version = detectSeratoVersion();

  if (version === 'v4') {
    const v4Path = getDefaultSeratoV4LibraryPath();
    return {
      found: true,
      path: v4Path,
      hasHistory: true,
      version: 'v4',
    };
  }

  // Check the default v3 path and any additional candidate paths.
  // Additional paths handle cases where the Music folder is in a non-default location
  // (e.g., redirected via OneDrive on Windows, or custom Serato library location).
  const v3CandidatePaths = [getDefaultSeratoPath(), ...(additionalV3Paths ?? [])];
  for (const candidatePath of v3CandidatePaths) {
    if (existsSync(candidatePath) && existsSync(join(candidatePath, 'History'))) {
      return {
        found: true,
        path: candidatePath,
        hasHistory: true,
        version: 'v3',
      };
    }
  }

  // Nothing found - return not found with the default path
  return {
    found: false,
    path: getDefaultSeratoPath(),
    hasHistory: false,
    version: 'unknown',
  };
}

/**
 * SeratoConnect monitors Serato DJ history files and emits events
 * when tracks change or new history entries are detected.
 * Supports both Serato 3 (binary format) and Serato 4 (SQLite database).
 */
export class SeratoConnect extends (EventEmitter as new () => TypedEmitter) {
  private options: Required<Omit<SeratoConnectOptions, 'seratoPath' | 'forceVersion' | 'logger'>> & {
    seratoPath: string;
    forceVersion?: SeratoVersion;
  };
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Current deck states - track loaded on each deck (1-4), or null if empty */
  private deckStates: (SeratoHistorySong | null)[] = [];
  private lastSessionMtime: number = 0;
  private lastSessionPath: string | null = null;
  private isRunning: boolean = false;
  /** Cursor for incremental history reads - tracks last processed index per session */
  private lastHistoryIndex: number = 0;
  /** Detected or forced Serato version */
  private detectedVersion: SeratoVersion = 'unknown';
  /** V4: Last session ID for change detection */
  private lastV4SessionId: number | null = null;
  /** V4: Last entry count for change detection */
  private lastV4EntryCount: number = 0;
  /** Pluggable logger instance */
  private logger: Logger;

  constructor(options: SeratoConnectOptions = {}) {
    super();
    this.logger = options.logger ?? noopLogger;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
      seratoPath: options.seratoPath || getDefaultSeratoPath(),
    };

    // Initialize deck states (all empty)
    this.deckStates = new Array(NUM_DECKS).fill(null);
  }

  /**
   * Get the detected Serato version.
   */
  get version(): SeratoVersion {
    return this.detectedVersion;
  }

  /**
   * Start monitoring Serato history files.
   * Automatically detects Serato version (v3 or v4) unless forced via options.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Detect version
    this.detectedVersion = this.options.forceVersion || detectSeratoVersion(this.options.seratoPath);

    this.logger.debug('start: detected version', JSON.stringify({
      version: this.detectedVersion,
      forcedVersion: this.options.forceVersion,
      seratoPath: this.options.seratoPath,
      pollIntervalMs: this.options.pollIntervalMs,
    }, null, 2));

    if (this.detectedVersion === 'v4') {
      await this.startV4();
    } else if (this.detectedVersion === 'v3') {
      await this.startV3();
    } else {
      this.emit('error', new Error('No Serato installation found'));
    }
  }

  /**
   * Start monitoring for Serato 3 (binary format).
   */
  private async startV3(): Promise<void> {
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

      // Load initial deck states from history
      const songs = await getSessionSongs(this.lastSessionPath);
      const newDeckStates = this.computeDeckStates(songs);

      // Emit initial deck states (all changes from null)
      for (let i = 0; i < NUM_DECKS; i++) {
        if (newDeckStates[i] !== null) {
          this.emit('deckChange', {
            deckId: i + 1,
            track: newDeckStates[i],
            previousTrack: null,
          });
        }
      }

      this.deckStates = newDeckStates;

      // Seed the history cursor so we only emit NEW tracks going forward
      this.lastHistoryIndex = songs.length;
    }

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), this.options.pollIntervalMs);
  }

  /**
   * Start monitoring for Serato 4 (SQLite database).
   */
  private async startV4(): Promise<void> {
    if (!hasSeratoV4Database()) {
      this.emit('error', new Error('Serato 4 database not found'));
      return;
    }

    this.isRunning = true;

    // Load initial sessions
    const sessions = getSeratoV4Sessions(undefined, this.logger);

    // Update stored path to v4 library path
    this.options.seratoPath = getDefaultSeratoV4LibraryPath();

    // Emit ready event
    this.emit('ready', {
      seratoPath: this.options.seratoPath,
      sessionCount: sessions.length,
    });

    // Get initial session info
    const sessionInfo = getLatestSessionInfoV4();
    if (sessionInfo) {
      this.lastV4SessionId = sessionInfo.id;
      this.lastV4EntryCount = sessionInfo.entryCount;
      this.lastSessionMtime = getDatabaseMtime();

      // Load initial deck states from history
      const songs = getLatestSessionSongsV4(undefined, this.logger);
      const newDeckStates = this.computeDeckStates(songs);

      // Emit initial deck states (all changes from null)
      for (let i = 0; i < NUM_DECKS; i++) {
        if (newDeckStates[i] !== null) {
          this.emit('deckChange', {
            deckId: i + 1,
            track: newDeckStates[i],
            previousTrack: null,
          });
        }
      }

      this.deckStates = newDeckStates;

      // Seed the history cursor so we only emit NEW tracks going forward
      this.lastHistoryIndex = songs.length;
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
    this.lastSessionMtime = 0;
    this.lastSessionPath = null;
    this.lastHistoryIndex = 0;
    this.lastV4SessionId = null;
    this.lastV4EntryCount = 0;

    // Reset deck states
    this.deckStates = new Array(NUM_DECKS).fill(null);
  }

  /**
   * Check if currently running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the track loaded on a specific deck.
   * @param deckId - Deck number (1-4)
   * @returns The track loaded on the deck, or null if empty
   */
  getDeckTrack(deckId: number): SeratoHistorySong | null {
    if (deckId < 1 || deckId > NUM_DECKS) {
      return null;
    }
    return this.deckStates[deckId - 1];
  }

  /**
   * Get all deck states.
   * @returns Array of tracks (or null) for decks 1-4
   */
  getAllDeckStates(): readonly (SeratoHistorySong | null)[] {
    return this.deckStates;
  }

  /**
   * Get the currently playing track.
   * @deprecated This method uses heuristics. Prefer listening to deckChange events
   * and using MIDI/mix processor to determine which deck is on-air.
   */
  getNowPlaying(): SeratoHistorySong | null {
    // Find loaded decks (tracks without end time)
    const loadedTracks = this.deckStates.filter((track): track is SeratoHistorySong => track !== null);

    if (loadedTracks.length === 0) {
      return null;
    }

    if (loadedTracks.length === 1) {
      return loadedTracks[0];
    }

    // Multiple decks loaded - return the one that started most recently
    loadedTracks.sort((a, b) => {
      const aTime = a.startTime?.getTime() || 0;
      const bTime = b.startTime?.getTime() || 0;
      return bTime - aTime; // Most recent first
    });

    return loadedTracks[0];
  }

  /**
   * Set the polling interval.
   * Takes effect immediately if currently running.
   * @param intervalMs - Polling interval in milliseconds
   */
  setPollInterval(intervalMs: number): void {
    this.options.pollIntervalMs = intervalMs;

    // Restart timer with new interval if running
    if (this.isRunning && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.poll(), intervalMs);
    }
  }

  /**
   * Get the current polling interval.
   * @returns Polling interval in milliseconds
   */
  get pollInterval(): number {
    return this.options.pollIntervalMs;
  }

  /**
   * Poll for changes.
   * Dispatches to version-specific poll method.
   */
  private async poll(): Promise<void> {
    try {
      this.emit('poll');

      if (this.detectedVersion === 'v4') {
        await this.pollV4();
      } else {
        await this.pollV3();
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Poll for changes in Serato 3 (binary format).
   */
  private async pollV3(): Promise<void> {
    this.logger.debug('pollV3: checking for changes');

    // Check for new session file
    const currentSessionPath = getLatestSessionPath(this.options.seratoPath);
    if (!currentSessionPath || !existsSync(currentSessionPath)) {
      this.logger.debug('pollV3: no session file found');
      return;
    }

    const stat = statSync(currentSessionPath);
    const currentMtime = stat.mtimeMs;

    this.logger.debug('pollV3: mtime comparison', JSON.stringify({
      currentPath: currentSessionPath,
      lastPath: this.lastSessionPath,
      currentMtime,
      lastMtime: this.lastSessionMtime,
      changed: currentSessionPath !== this.lastSessionPath || currentMtime !== this.lastSessionMtime,
    }, null, 2));

    // Check if session file changed
    if (currentSessionPath !== this.lastSessionPath || currentMtime !== this.lastSessionMtime) {
      // Session changed or updated
      const isNewSession = currentSessionPath !== this.lastSessionPath;

      // Reset cursor and deck states on new session
      if (isNewSession) {
        this.lastHistoryIndex = 0;
        // Emit eject events for any loaded decks
        for (let i = 0; i < NUM_DECKS; i++) {
          if (this.deckStates[i] !== null) {
            this.emit('deckChange', {
              deckId: i + 1,
              track: null,
              previousTrack: this.deckStates[i],
            });
          }
        }
        this.deckStates = new Array(NUM_DECKS).fill(null);
      }

      this.lastSessionPath = currentSessionPath;
      this.lastSessionMtime = currentMtime;

      // Parse the session and compute new deck states
      const songs = await getSessionSongs(currentSessionPath);

      this.logger.debug('pollV3: songs returned from database', JSON.stringify({
        totalSongs: songs.length,
        songs: songs.map((s) => ({
          title: s.title,
          artist: s.artist,
          deck: s.deck,
          startTime: s.startTime?.toISOString(),
          playTime: s.playTime?.toISOString(),
          played: s.played,
          bpm: s.bpm,
        })),
      }, null, 2));

      const newDeckStates = this.computeDeckStates(songs);

      this.logger.debug('pollV3: computed deck states', JSON.stringify({
        deckStates: newDeckStates.map((s, i) =>
          s ? { deck: i + 1, title: s.title, artist: s.artist } : { deck: i + 1, empty: true }
        ),
      }, null, 2));

      // Compare and emit deck changes
      this.emitDeckChanges(newDeckStates);

      // Emit history for only NEW tracks since last poll (incremental)
      const newTracks = songs.slice(this.lastHistoryIndex);
      this.logger.debug('pollV3: new tracks since last poll', JSON.stringify({
        lastHistoryIndex: this.lastHistoryIndex,
        newTracksCount: newTracks.length,
        newTracks: newTracks.map((s) => ({ title: s.title, artist: s.artist, deck: s.deck })),
      }, null, 2));
      if (newTracks.length > 0) {
        this.lastHistoryIndex = songs.length;
        this.emit('history', {
          seratoPath: this.options.seratoPath,
          count: newTracks.length,
          tracks: newTracks.slice(-this.options.historyMaxRows),
          lastTrackIndex: this.lastHistoryIndex,
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
  }

  /**
   * Poll for changes in Serato 4 (SQLite database).
   */
  private async pollV4(): Promise<void> {
    this.logger.debug('pollV4: checking for changes');

    // Check database mtime for quick change detection
    // NOTE: Serato 4 keeps the database file open, so mtime may not update
    // until Serato closes. We use mtime as a hint but also check the database
    // content periodically.
    const currentMtime = getDatabaseMtime();
    const mtimeChanged = currentMtime !== this.lastSessionMtime;

    this.logger.debug('pollV4: mtime comparison', JSON.stringify({
      currentMtime,
      lastMtime: this.lastSessionMtime,
      changed: mtimeChanged,
    }, null, 2));

    // Always update stored mtime
    this.lastSessionMtime = currentMtime;

    // Get current session info
    const sessionInfo = getLatestSessionInfoV4();

    this.logger.debug('pollV4: session info', JSON.stringify({
      sessionInfo,
      lastSessionId: this.lastV4SessionId,
      lastEntryCount: this.lastV4EntryCount,
    }, null, 2));

    if (!sessionInfo) {
      this.logger.debug('pollV4: no session found');
      return;
    }

    // Check if session changed
    const isNewSession = sessionInfo.id !== this.lastV4SessionId;
    this.logger.debug('pollV4: session comparison', JSON.stringify({
      isNewSession,
      currentSessionId: sessionInfo.id,
      lastSessionId: this.lastV4SessionId,
    }, null, 2));

    // Reset cursor and deck states on new session
    if (isNewSession) {
      this.lastHistoryIndex = 0;
      // Emit eject events for any loaded decks
      for (let i = 0; i < NUM_DECKS; i++) {
        if (this.deckStates[i] !== null) {
          this.emit('deckChange', {
            deckId: i + 1,
            track: null,
            previousTrack: this.deckStates[i],
          });
        }
      }
      this.deckStates = new Array(NUM_DECKS).fill(null);
      this.lastV4SessionId = sessionInfo.id;
    }

    // Check if entry count changed (new tracks added)
    if (sessionInfo.entryCount === this.lastV4EntryCount && !isNewSession) {
      this.logger.debug('pollV4: no new entries (count unchanged)', JSON.stringify({
        entryCount: sessionInfo.entryCount,
        lastEntryCount: this.lastV4EntryCount,
      }, null, 2));
      return; // No new entries
    }

    // Get songs from latest session
    const songs = getLatestSessionSongsV4(undefined, this.logger);

    this.logger.debug('pollV4: songs returned from database', JSON.stringify({
      totalSongs: songs.length,
      songs: songs.map((s) => ({
        title: s.title,
        artist: s.artist,
        deck: s.deck,
        startTime: s.startTime?.toISOString(),
        playTime: s.playTime?.toISOString(),
        played: s.played,
        bpm: s.bpm,
        filePath: s.filePath,
        artworkUrl: s.artworkUrl,
        streamingSource: s.streamingSource,
        streamingId: s.streamingId,
        album: s.album,
        label: s.label,
      })),
    }, null, 2));

    const newDeckStates = this.computeDeckStates(songs);

    this.logger.debug('pollV4: computed deck states', JSON.stringify({
      deckStates: newDeckStates.map((s, i) =>
        s ? { deck: i + 1, title: s.title, artist: s.artist } : { deck: i + 1, empty: true }
      ),
    }, null, 2));

    // Compare and emit deck changes
    this.emitDeckChanges(newDeckStates);

    // Emit history for only NEW tracks since last poll (incremental)
    const newTracks = songs.slice(this.lastHistoryIndex);
    this.logger.debug('pollV4: new tracks since last poll', JSON.stringify({
      lastHistoryIndex: this.lastHistoryIndex,
      newTracksCount: newTracks.length,
      newTracks: newTracks.map((s) => ({ title: s.title, artist: s.artist, deck: s.deck })),
    }, null, 2));
    if (newTracks.length > 0) {
      this.lastHistoryIndex = songs.length;
      this.lastV4EntryCount = sessionInfo.entryCount;
      this.emit('history', {
        seratoPath: this.options.seratoPath,
        count: newTracks.length,
        tracks: newTracks.slice(-this.options.historyMaxRows),
        lastTrackIndex: this.lastHistoryIndex,
      });
    }

    // Emit session event if it's a new session
    if (isNewSession) {
      this.emit('session', {
        session: {
          date: new Date().toISOString().split('T')[0],
          index: sessionInfo.id,
          songs,
        },
      });
    }
  }

  /**
   * Compute current deck states from session history.
   * For each deck, finds the most recent track that is still loaded (has startTime, no playTime).
   */
  private computeDeckStates(songs: SeratoHistorySong[]): (SeratoHistorySong | null)[] {
    const states: (SeratoHistorySong | null)[] = new Array(NUM_DECKS).fill(null);

    // Process songs in order - later entries override earlier ones for the same deck
    for (const song of songs) {
      if (song.deck && song.deck >= 1 && song.deck <= NUM_DECKS) {
        const deckIndex = song.deck - 1;

        if (song.startTime !== undefined && song.playTime === undefined) {
          // Track is loaded (has start time, no end time yet)
          states[deckIndex] = song;
        } else if (song.playTime !== undefined) {
          // Track was ejected (has end time) - deck is now empty
          states[deckIndex] = null;
        }
      }
    }

    return states;
  }

  /**
   * Compare new deck states to current states and emit deckChange events for differences.
   */
  private emitDeckChanges(newStates: (SeratoHistorySong | null)[]): void {
    for (let i = 0; i < NUM_DECKS; i++) {
      const previous = this.deckStates[i];
      const current = newStates[i];

      // Check if deck state changed
      const previousKey = this.getTrackKey(previous);
      const currentKey = this.getTrackKey(current);

      if (previousKey !== currentKey) {
        this.emit('deckChange', {
          deckId: i + 1,
          track: current,
          previousTrack: previous,
        });
      }
    }

    // Update stored state
    this.deckStates = newStates;
  }

  /**
   * Create a unique key for a track to detect changes.
   * Returns null for null tracks.
   *
   * The `played` flag is part of the key: Serato flips it from false→true in
   * place (same artist/title/startTime) once a loaded track passes its
   * play-count threshold. Consumers route the two states differently — a
   * loaded-only deck shows in the DJ interface, a played deck emits to the
   * overlay — so the load→play transition must count as a change and re-emit
   * `deckChange`. Excluding `played` here swallowed that second event and left
   * the overlay empty for the whole set (NP3-283).
   */
  private getTrackKey(track: SeratoHistorySong | null): string | null {
    if (!track) return null;
    return `${track.artist}|${track.title}|${track.startTime?.getTime() || 0}|${track.played ? 1 : 0}`;
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
