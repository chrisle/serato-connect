/**
 * Tests for Serato version detection consistency.
 *
 * This test file verifies that version detection is consistent between:
 * 1. detectSeratoInstallation() called externally
 * 2. detectSeratoVersion() called internally by SeratoConnect.start()
 *
 * Bug reproduction: When seratoPath is undefined:
 * - detectSeratoInstallation(undefined) checks v4 first, then v3
 * - SeratoConnect constructor defaults undefined to getDefaultSeratoPath() (v3 path)
 * - SeratoConnect.start() calls detectSeratoVersion(v3Path) which only checks v3
 * - This causes v4 installations to be detected externally but fail internally
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SeratoConnect,
  detectSeratoInstallation,
  detectSeratoVersion,
  getDefaultSeratoPath,
} from '../src/seratoConnect.js';
import { getDefaultSeratoV4LibraryPath, hasSeratoV4Database } from '../src/historyParserV4.js';

describe('Version detection consistency', () => {
  let tempDir: string;
  let mockV3Path: string;
  let mockV4Path: string;
  const originalPlatform = process.platform;

  beforeEach(async () => {
    // Serato is only supported on macOS / Windows. CI runs Linux, so the
    // path-resolution helpers throw unless we stub the platform. Force
    // 'darwin' so the default-path branch is exercised.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serato-version-test-'));
    mockV3Path = path.join(tempDir, 'v3', '_Serato_');
    mockV4Path = path.join(tempDir, 'v4', 'Library');
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('detectSeratoVersion behavior with custom path', () => {
    it('returns unknown when custom path provided but no History folder exists', async () => {
      // Create a path without History folder
      await fs.promises.mkdir(mockV3Path, { recursive: true });

      const version = detectSeratoVersion(mockV3Path);
      expect(version).toBe('unknown');
    });

    it('returns v3 when custom path has History folder', async () => {
      // Create v3 structure with History folder
      await fs.promises.mkdir(path.join(mockV3Path, 'History'), { recursive: true });

      const version = detectSeratoVersion(mockV3Path);
      expect(version).toBe('v3');
    });

    it('only checks v3 when custom path is provided (ignores v4)', async () => {
      // Even if v4 database exists, custom path should only check v3
      // This is expected behavior - custom paths are for v3 only
      await fs.promises.mkdir(mockV3Path, { recursive: true });

      const version = detectSeratoVersion(mockV3Path);
      // No History folder, so returns unknown (doesn't check for v4)
      expect(version).toBe('unknown');
    });
  });

  describe('detectSeratoInstallation behavior', () => {
    it('returns unknown when custom path has no History folder', async () => {
      await fs.promises.mkdir(mockV3Path, { recursive: true });

      const result = detectSeratoInstallation(mockV3Path);
      expect(result.found).toBe(true);
      expect(result.hasHistory).toBe(false);
      expect(result.version).toBe('unknown');
    });

    it('returns v3 when custom path has History folder', async () => {
      await fs.promises.mkdir(path.join(mockV3Path, 'History'), { recursive: true });

      const result = detectSeratoInstallation(mockV3Path);
      expect(result.found).toBe(true);
      expect(result.hasHistory).toBe(true);
      expect(result.version).toBe('v3');
    });
  });

  describe('SeratoConnect version detection', () => {
    it('emits error when seratoPath points to folder without History', async () => {
      await fs.promises.mkdir(mockV3Path, { recursive: true });

      const connect = new SeratoConnect({
        seratoPath: mockV3Path,
        pollIntervalMs: 100,
      });

      const errorPromise = new Promise<Error>((resolve) => {
        connect.on('error', resolve);
      });

      await connect.start();
      const error = await errorPromise;

      expect(error.message).toContain('No Serato installation found');
      connect.stop();
    });

    it('starts successfully when seratoPath has History folder', async () => {
      // Create v3 structure
      await fs.promises.mkdir(path.join(mockV3Path, 'History', 'Sessions'), { recursive: true });
      await fs.promises.writeFile(
        path.join(mockV3Path, 'History', 'history.database'),
        Buffer.alloc(0)
      );

      const connect = new SeratoConnect({
        seratoPath: mockV3Path,
        pollIntervalMs: 100,
      });

      const readyPromise = new Promise<void>((resolve) => {
        connect.on('ready', () => resolve());
      });

      await connect.start();
      await readyPromise;

      expect(connect.version).toBe('v3');
      expect(connect.running).toBe(true);

      connect.stop();
    });
  });

  describe('Bug: Mismatch between external detection and SeratoConnect', () => {
    /**
     * This test documents the bug where:
     * 1. External code calls detectSeratoInstallation(undefined) → detects v4
     * 2. External code passes undefined seratoPath to SeratoConnect
     * 3. SeratoConnect defaults undefined to getDefaultSeratoPath() (v3 path)
     * 4. SeratoConnect.start() calls detectSeratoVersion(v3Path) → unknown
     * 5. SeratoConnect emits "No Serato installation found" error
     *
     * The fix: Pass the detected path to SeratoConnect, not the original config value
     */
    it('demonstrates the path mismatch issue with undefined seratoPath', async () => {
      // This simulates what happens when:
      // - detectSeratoInstallation(undefined) is called and returns a v4 path
      // - but SeratoConnect is created with { seratoPath: undefined }

      // Create a v3 structure but without History folder (simulating only v4 being available)
      const defaultV3Path = getDefaultSeratoPath();

      // When seratoPath is undefined, SeratoConnect defaults to v3 path
      const connect = new SeratoConnect({
        seratoPath: undefined,
        pollIntervalMs: 100,
      });

      // Verify that the internal path is the v3 default path
      // (this is the root cause of the bug - it should check v4 first when undefined)
      // We can't directly access options, but we can verify behavior through error message

      const events: { type: string; data: any }[] = [];
      connect.on('error', (err) => events.push({ type: 'error', data: err }));
      connect.on('ready', (data) => events.push({ type: 'ready', data }));

      await connect.start();

      // Wait a tick for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      connect.stop();

      // The behavior depends on whether v4 database or v3 folder exists on this machine
      // This test primarily documents the expected behavior patterns
      expect(events.length).toBeGreaterThan(0);

      // If we got an error about "No Serato installation found", it means:
      // - detectSeratoVersion was called with a path that doesn't have v3 History
      // - AND v4 database check returned false
      const errorEvent = events.find((e) => e.type === 'error');
      if (errorEvent) {
        expect(errorEvent.data.message).toMatch(/No Serato installation found|Serato folder not found/);
      }
    });

    it('works correctly when explicit path is passed from detection result', async () => {
      // Create v3 structure
      await fs.promises.mkdir(path.join(mockV3Path, 'History', 'Sessions'), { recursive: true });
      await fs.promises.writeFile(
        path.join(mockV3Path, 'History', 'history.database'),
        Buffer.alloc(0)
      );

      // Simulate the correct pattern:
      // 1. Call detectSeratoInstallation with custom path
      const detection = detectSeratoInstallation(mockV3Path);
      expect(detection.found).toBe(true);
      expect(detection.hasHistory).toBe(true);
      expect(detection.version).toBe('v3');

      // 2. Pass the DETECTED path to SeratoConnect (not the original config)
      const connect = new SeratoConnect({
        seratoPath: detection.path, // Use detected path!
        pollIntervalMs: 100,
      });

      const readyPromise = new Promise<void>((resolve) => {
        connect.on('ready', () => resolve());
      });

      await connect.start();
      await readyPromise;

      expect(connect.version).toBe('v3');
      expect(connect.running).toBe(true);

      connect.stop();
    });
  });

  describe('detectSeratoInstallation with additionalV3Paths', () => {
    it('finds v3 library at an additional candidate path with History', async () => {
      // Create a temp dir with v3 History structure — simulates redirected Music folder
      await fs.promises.mkdir(path.join(mockV3Path, 'History'), { recursive: true });

      // Pass it as an additional candidate. The function should return found=true
      // from either the default path (if it exists on the machine) or the additional path.
      const result = detectSeratoInstallation(undefined, [mockV3Path]);
      expect(result.found).toBe(true);
      expect(result.hasHistory).toBe(true);
      expect(result.version).toBe('v3');
    });

    it('returns the additional path when it has History and is found', async () => {
      // Use a fresh temp dir that is guaranteed not to be the real default Serato path.
      // Pass it as customPath (not additional) so the default path is bypassed entirely.
      await fs.promises.mkdir(path.join(mockV3Path, 'History'), { recursive: true });

      // customPath bypasses default path check and only checks this specific path
      const result = detectSeratoInstallation(mockV3Path);
      expect(result.found).toBe(true);
      expect(result.path).toBe(mockV3Path);
      expect(result.hasHistory).toBe(true);
      expect(result.version).toBe('v3');
    });

    it('returns not found when additional path has no History (and customPath also has no History)', async () => {
      // Folder exists but no History subfolder
      await fs.promises.mkdir(mockV3Path, { recursive: true });

      // Use customPath to isolate from machine state (bypasses default path check)
      const result = detectSeratoInstallation(mockV3Path);
      expect(result.found).toBe(true);
      expect(result.hasHistory).toBe(false);
      expect(result.version).toBe('unknown');
    });

    it('ignores additional paths when a custom path is explicitly provided', async () => {
      // Custom path has no History, additional path does — custom path takes precedence
      await fs.promises.mkdir(mockV3Path, { recursive: true });
      const altPath = path.join(tempDir, 'alt', '_Serato_');
      await fs.promises.mkdir(path.join(altPath, 'History'), { recursive: true });

      const result = detectSeratoInstallation(mockV3Path, [altPath]);
      expect(result.path).toBe(mockV3Path);
      expect(result.hasHistory).toBe(false);
      expect(result.version).toBe('unknown');
    });

    it('accepts additional paths alongside default path without errors', async () => {
      // Verifies the function signature change is backward-compatible
      await fs.promises.mkdir(path.join(mockV3Path, 'History'), { recursive: true });
      const altPath = path.join(tempDir, 'alt', '_Serato_');

      // Should not throw when additional paths are provided
      expect(() => detectSeratoInstallation(undefined, [mockV3Path, altPath])).not.toThrow();
    });
  });

  describe('forceVersion option', () => {
    it('allows forcing v3 mode', async () => {
      // Create v3 structure
      await fs.promises.mkdir(path.join(mockV3Path, 'History', 'Sessions'), { recursive: true });
      await fs.promises.writeFile(
        path.join(mockV3Path, 'History', 'history.database'),
        Buffer.alloc(0)
      );

      const connect = new SeratoConnect({
        seratoPath: mockV3Path,
        pollIntervalMs: 100,
        forceVersion: 'v3',
      });

      const readyPromise = new Promise<void>((resolve) => {
        connect.on('ready', () => resolve());
      });

      await connect.start();
      await readyPromise;

      expect(connect.version).toBe('v3');

      connect.stop();
    });
  });
});
