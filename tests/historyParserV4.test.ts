/**
 * Tests for historyParserV4 helpers.
 */

import { describe, it, expect } from 'vitest';
import { parseDeckValue } from '../src/historyParserV4.js';

describe('parseDeckValue', () => {
  it('returns undefined for null', () => {
    expect(parseDeckValue(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseDeckValue(undefined)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseDeckValue('')).toBeUndefined();
  });

  it('parses numeric string "1" to 1', () => {
    expect(parseDeckValue('1')).toBe(1);
  });

  it('parses numeric string "4" to 4', () => {
    expect(parseDeckValue('4')).toBe(4);
  });

  it('returns undefined for out-of-range numeric "0"', () => {
    expect(parseDeckValue('0')).toBeUndefined();
  });

  it('returns undefined for out-of-range numeric "5"', () => {
    expect(parseDeckValue('5')).toBeUndefined();
  });

  it('maps letter "A" to 1', () => {
    expect(parseDeckValue('A')).toBe(1);
  });

  it('maps letter "B" to 2', () => {
    expect(parseDeckValue('B')).toBe(2);
  });

  it('maps letter "C" to 3', () => {
    expect(parseDeckValue('C')).toBe(3);
  });

  it('maps letter "D" to 4', () => {
    expect(parseDeckValue('D')).toBe(4);
  });

  it('handles lowercase letters', () => {
    expect(parseDeckValue('a')).toBe(1);
    expect(parseDeckValue('b')).toBe(2);
  });

  it('returns undefined for unknown letter "E"', () => {
    expect(parseDeckValue('E')).toBeUndefined();
  });

  it('returns undefined for non-numeric non-letter string', () => {
    expect(parseDeckValue('foo')).toBeUndefined();
  });
});
