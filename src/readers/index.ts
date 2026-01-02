/**
 * Audio file readers for extracting Serato metadata.
 *
 * Uses music-metadata to read ID3/FLAC/MP4 tags, then extracts and parses
 * Serato-specific metadata from GEOB frames or Vorbis comments.
 *
 * Supported formats:
 * - MP3/AIFF: ID3v2.4 GEOB frames
 * - FLAC: Vorbis comments
 * - Ogg Vorbis: Vorbis comments
 * - MP4/M4A: Custom atoms (mean: com.serato.dj)
 *
 * Implementation based on:
 * - music-metadata by @Borewit: https://github.com/Borewit/music-metadata
 * - serato-tags format docs by @Holzhaus: https://github.com/Holzhaus/serato-tags
 * - triseratops by @Holzhaus: https://github.com/Holzhaus/triseratops
 *
 * @module readers
 */

import { parseFile, type IAudioMetadata, type ITag } from 'music-metadata';
import { SeratoTrackMetadata } from '../types.js';
import {
  parseMarkers2,
  parseMarkers2FromBase64,
  parseBeatgrid,
  parseBeatgridFromBase64,
  parseAutotags,
  parseAutotagsFromBase64,
} from '../parsers/geob/index.js';

/**
 * Serato GEOB frame descriptions used in ID3 tags.
 */
const GEOB_DESCRIPTIONS = {
  MARKERS2: 'Serato Markers2',
  BEATGRID: 'Serato BeatGrid',
  AUTOTAGS: 'Serato Autotags',
  OVERVIEW: 'Serato Overview',
} as const;

/**
 * Serato Vorbis comment field names (FLAC/Ogg).
 */
const VORBIS_FIELDS = {
  MARKERS2: 'SERATO_MARKERS_V2',
  BEATGRID: 'SERATO_BEATGRID',
  AUTOTAGS: 'SERATO_AUTOTAGS',
  OVERVIEW: 'SERATO_OVERVIEW',
} as const;

/**
 * Serato MP4 atom names (mean: com.serato.dj).
 */
const MP4_ATOMS = {
  MARKERS2: 'markersv2',
  BEATGRID: 'beatgrid',
  AUTOTAGS: 'autotags',
  OVERVIEW: 'overview',
} as const;

/**
 * Extract GEOB frame data from ID3 native tags (MP3/AIFF).
 *
 * GEOB frames have the structure:
 * - id: 'GEOB'
 * - value: { description: string, data: Buffer }
 */
function extractGeobData(
  nativeTags: ITag[],
  description: string
): Buffer | undefined {
  for (const tag of nativeTags) {
    if (tag.id === 'GEOB' && typeof tag.value === 'object') {
      const geob = tag.value as { description?: string; data?: Uint8Array };
      if (geob.description === description && geob.data) {
        return Buffer.from(geob.data);
      }
    }
  }
  return undefined;
}

/**
 * Extract Vorbis comment data (FLAC/Ogg).
 *
 * Vorbis comments are key=value pairs. Serato data is base64 encoded.
 */
function extractVorbisComment(
  nativeTags: ITag[],
  fieldName: string
): string | undefined {
  for (const tag of nativeTags) {
    if (tag.id.toUpperCase() === fieldName.toUpperCase()) {
      return tag.value as string;
    }
  }
  return undefined;
}

/**
 * Extract MP4 custom atom data.
 *
 * MP4 Serato atoms use mean: com.serato.dj
 */
function extractMp4Atom(
  nativeTags: ITag[],
  atomName: string
): Buffer | undefined {
  for (const tag of nativeTags) {
    // MP4 tags from music-metadata use format "----:com.serato.dj:atomname"
    if (tag.id.includes(`:com.serato.dj:${atomName}`)) {
      if (Buffer.isBuffer(tag.value)) {
        return tag.value;
      }
      if (tag.value instanceof Uint8Array) {
        return Buffer.from(tag.value);
      }
    }
  }
  return undefined;
}

/**
 * Parse Serato metadata from ID3 native tags (MP3/AIFF).
 */
function parseFromId3(nativeTags: ITag[]): SeratoTrackMetadata {
  const result: SeratoTrackMetadata = {};

  // Parse Markers2
  const markers2Data = extractGeobData(nativeTags, GEOB_DESCRIPTIONS.MARKERS2);
  if (markers2Data) {
    try {
      // GEOB data contains: header (0x01 0x01) + base64 content + null padding
      // Skip header and extract base64 content
      let offset = 0;
      if (markers2Data.length >= 2 && markers2Data[0] === 0x01 && markers2Data[1] === 0x01) {
        offset = 2;
      }
      // Find end of base64 (before null padding)
      let end = markers2Data.length;
      while (end > offset && markers2Data[end - 1] === 0) {
        end--;
      }
      const base64Content = markers2Data.subarray(offset, end).toString('ascii');
      result.markers = parseMarkers2FromBase64(base64Content);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse BeatGrid
  const beatgridData = extractGeobData(nativeTags, GEOB_DESCRIPTIONS.BEATGRID);
  if (beatgridData) {
    try {
      result.beatgrid = parseBeatgrid(beatgridData);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse Autotags
  const autotagsData = extractGeobData(nativeTags, GEOB_DESCRIPTIONS.AUTOTAGS);
  if (autotagsData) {
    try {
      result.autotags = parseAutotags(autotagsData);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse Overview (raw waveform data)
  const overviewData = extractGeobData(nativeTags, GEOB_DESCRIPTIONS.OVERVIEW);
  if (overviewData) {
    result.overview = new Uint8Array(overviewData);
  }

  return result;
}

/**
 * Parse Serato metadata from Vorbis comments (FLAC/Ogg).
 */
function parseFromVorbis(nativeTags: ITag[]): SeratoTrackMetadata {
  const result: SeratoTrackMetadata = {};

  // Parse Markers2
  const markers2Base64 = extractVorbisComment(nativeTags, VORBIS_FIELDS.MARKERS2);
  if (markers2Base64) {
    try {
      result.markers = parseMarkers2FromBase64(markers2Base64);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse BeatGrid
  const beatgridBase64 = extractVorbisComment(nativeTags, VORBIS_FIELDS.BEATGRID);
  if (beatgridBase64) {
    try {
      result.beatgrid = parseBeatgridFromBase64(beatgridBase64);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse Autotags
  const autotagsBase64 = extractVorbisComment(nativeTags, VORBIS_FIELDS.AUTOTAGS);
  if (autotagsBase64) {
    try {
      result.autotags = parseAutotagsFromBase64(autotagsBase64);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse Overview
  const overviewBase64 = extractVorbisComment(nativeTags, VORBIS_FIELDS.OVERVIEW);
  if (overviewBase64) {
    try {
      const cleaned = overviewBase64.replace(/\s/g, '');
      const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
      const buffer = Buffer.from(cleaned + '='.repeat(paddingNeeded), 'base64');
      result.overview = new Uint8Array(buffer);
    } catch {
      // Silently ignore parse errors
    }
  }

  return result;
}

/**
 * Parse Serato metadata from MP4 atoms (M4A/MP4).
 */
function parseFromMp4(nativeTags: ITag[]): SeratoTrackMetadata {
  const result: SeratoTrackMetadata = {};

  // Parse Markers2
  const markers2Data = extractMp4Atom(nativeTags, MP4_ATOMS.MARKERS2);
  if (markers2Data) {
    try {
      result.markers = parseMarkers2(markers2Data);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse BeatGrid
  const beatgridData = extractMp4Atom(nativeTags, MP4_ATOMS.BEATGRID);
  if (beatgridData) {
    try {
      result.beatgrid = parseBeatgrid(beatgridData);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse Autotags
  const autotagsData = extractMp4Atom(nativeTags, MP4_ATOMS.AUTOTAGS);
  if (autotagsData) {
    try {
      result.autotags = parseAutotags(autotagsData);
    } catch {
      // Silently ignore parse errors
    }
  }

  // Parse Overview
  const overviewData = extractMp4Atom(nativeTags, MP4_ATOMS.OVERVIEW);
  if (overviewData) {
    result.overview = new Uint8Array(overviewData);
  }

  return result;
}

/**
 * Read Serato metadata from an audio file.
 *
 * Supports MP3, AIFF, FLAC, Ogg Vorbis, M4A/MP4.
 *
 * @param filePath - Path to the audio file
 * @returns Serato metadata, or null if no Serato data found or file unreadable
 */
export async function getTrackMetadata(
  filePath: string
): Promise<SeratoTrackMetadata | null> {
  let metadata: IAudioMetadata;

  try {
    metadata = await parseFile(filePath, {
      skipCovers: true,
      includeChapters: false,
    });
  } catch {
    return null;
  }

  // Determine format and extract native tags
  const native = metadata.native;
  if (!native) {
    return null;
  }

  let result: SeratoTrackMetadata = {};

  // ID3v2.4 (MP3)
  if (native['ID3v2.4']) {
    result = parseFromId3(native['ID3v2.4']);
  }
  // ID3v2.3 (older MP3)
  else if (native['ID3v2.3']) {
    result = parseFromId3(native['ID3v2.3']);
  }
  // ID3v2.2 (even older MP3)
  else if (native['ID3v2.2']) {
    result = parseFromId3(native['ID3v2.2']);
  }
  // AIFF (uses ID3v2)
  else if (native['ID3v2.4-aiff']) {
    result = parseFromId3(native['ID3v2.4-aiff']);
  }
  // Vorbis (FLAC, Ogg)
  else if (native['vorbis']) {
    result = parseFromVorbis(native['vorbis']);
  }
  // iTunes/MP4
  else if (native['iTunes']) {
    result = parseFromMp4(native['iTunes']);
  }

  // Check if we found any Serato data
  if (!result.markers && !result.beatgrid && !result.autotags && !result.overview) {
    return null;
  }

  return result;
}

/**
 * Read Serato metadata from audio file data buffer.
 *
 * Useful when the file is already loaded in memory.
 *
 * @param buffer - Audio file data
 * @param mimeType - MIME type of the audio (e.g., 'audio/mpeg', 'audio/flac')
 * @returns Serato metadata, or null if no Serato data found
 */
export async function getTrackMetadataFromBuffer(
  buffer: Buffer,
  mimeType: string
): Promise<SeratoTrackMetadata | null> {
  const { parseBuffer } = await import('music-metadata');

  let metadata: IAudioMetadata;

  try {
    metadata = await parseBuffer(buffer, {
      mimeType,
      skipCovers: true,
      includeChapters: false,
    });
  } catch {
    return null;
  }

  // Same logic as getTrackMetadata
  const native = metadata.native;
  if (!native) {
    return null;
  }

  let result: SeratoTrackMetadata = {};

  if (native['ID3v2.4']) {
    result = parseFromId3(native['ID3v2.4']);
  } else if (native['ID3v2.3']) {
    result = parseFromId3(native['ID3v2.3']);
  } else if (native['ID3v2.2']) {
    result = parseFromId3(native['ID3v2.2']);
  } else if (native['ID3v2.4-aiff']) {
    result = parseFromId3(native['ID3v2.4-aiff']);
  } else if (native['vorbis']) {
    result = parseFromVorbis(native['vorbis']);
  } else if (native['iTunes']) {
    result = parseFromMp4(native['iTunes']);
  }

  if (!result.markers && !result.beatgrid && !result.autotags && !result.overview) {
    return null;
  }

  return result;
}
