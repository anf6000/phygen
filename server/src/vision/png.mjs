// ─────────────────────────────────────────────────────────────────────────────
// png.mjs — a small, zero-dependency PNG decoder.
//
// The perceptual gate measures the captured PNG, which is the artifact a person
// sees. PNG stores its pixels as zlib-deflated, filtered scanlines, so this
// module inflates the IDAT chunks, reverses the per-scanline filter, and returns
// one RGBA byte buffer.
//
// Only the common capture format is decoded: 8-bit, non-interlaced, with a gray,
// RGB, palette, gray+alpha, or RGBA color type. Any other input is a RECORDED
// skip, never a silent zero: the caller must hold a value it did not measure.
// ─────────────────────────────────────────────────────────────────────────────
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for each supported color type, at 8-bit depth. */
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

export class PngError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PngError';
    this.code = code;
    this.details = details;
  }
}

/** True when the buffer starts with the eight-byte PNG signature. */
export function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/** Walk the chunk stream of a PNG buffer. */
function* chunks(buffer) {
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new PngError('png_invalid', `The chunk ${type} runs past the end of the file`);
    }
    const data = buffer.subarray(dataStart, dataEnd);
    const expected = buffer.readUInt32BE(dataEnd);
    const actual = crc32(buffer.subarray(offset + 4, dataEnd)) >>> 0;
    if (expected !== actual) {
      throw new PngError('png_invalid', `The chunk ${type} has a bad checksum`, { type });
    }
    yield { type, data };
    offset = dataEnd + 4;
  }
}

/** Reverse the PNG scanline filters in place, row by row. */
function unfilter(raw, width, height, bpp, bytesPerRow) {
  const out = new Uint8Array(height * bytesPerRow);
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source++];
    const rowStart = y * bytesPerRow;
    const prevStart = (y - 1) * bytesPerRow;
    for (let x = 0; x < bytesPerRow; x++) {
      const value = raw[source + x];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let result;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4:
          result = value + paeth(left, up, upLeft);
          break;
        default:
          throw new PngError('png_invalid', `Unknown scanline filter ${filter} on row ${y}`, { filter, row: y });
      }
      out[rowStart + x] = result & 0xff;
    }
    source += bytesPerRow;
  }
  return out;
}

/** The Paeth predictor from the PNG specification. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function expandToRgba(rows, width, height, colorType, palette, transparency) {
  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  const channels = CHANNELS[colorType];
  for (let index = 0; index < pixels; index++) {
    const source = index * channels;
    const target = index * 4;
    switch (colorType) {
      case 0: {
        const gray = rows[source];
        rgba[target] = gray;
        rgba[target + 1] = gray;
        rgba[target + 2] = gray;
        rgba[target + 3] = 255;
        break;
      }
      case 2: {
        rgba[target] = rows[source];
        rgba[target + 1] = rows[source + 1];
        rgba[target + 2] = rows[source + 2];
        rgba[target + 3] = 255;
        break;
      }
      case 3: {
        const entry = rows[source] * 3;
        rgba[target] = palette[entry] ?? 0;
        rgba[target + 1] = palette[entry + 1] ?? 0;
        rgba[target + 2] = palette[entry + 2] ?? 0;
        rgba[target + 3] = transparency[rows[source]] ?? 255;
        break;
      }
      case 4: {
        const gray = rows[source];
        rgba[target] = gray;
        rgba[target + 1] = gray;
        rgba[target + 2] = gray;
        rgba[target + 3] = rows[source + 1];
        break;
      }
      default: {
        rgba[target] = rows[source];
        rgba[target + 1] = rows[source + 1];
        rgba[target + 2] = rows[source + 2];
        rgba[target + 3] = rows[source + 3];
        break;
      }
    }
  }
  return rgba;
}

/**
 * Decode one PNG into an RGBA byte buffer.
 *
 * @param {Buffer} buffer the whole PNG file
 * @param {object} [options]
 * @param {number} [options.maxPixels] refuse a frame above this pixel count
 * @returns {{width: number, height: number, rgba: Uint8Array, colorType: number}}
 * @throws {PngError} with code `png_unsupported` or `png_invalid`
 */
export function decodePng(buffer, { maxPixels = 4096 * 4096 } = {}) {
  if (!isPng(buffer)) throw new PngError('png_invalid', 'The buffer is not a PNG file (bad signature)');

  let header = null;
  const idat = [];
  let palette = null;
  let transparency = null;

  for (const chunk of chunks(buffer)) {
    if (chunk.type === 'IHDR') {
      header = {
        width: chunk.data.readUInt32BE(0),
        height: chunk.data.readUInt32BE(4),
        bitDepth: chunk.data[8],
        colorType: chunk.data[9],
        compression: chunk.data[10],
        filter: chunk.data[11],
        interlace: chunk.data[12],
      };
    } else if (chunk.type === 'PLTE') {
      palette = chunk.data;
    } else if (chunk.type === 'tRNS') {
      transparency = chunk.data;
    } else if (chunk.type === 'IDAT') {
      idat.push(chunk.data);
    } else if (chunk.type === 'IEND') {
      break;
    }
  }

  if (!header) throw new PngError('png_invalid', 'The PNG has no IHDR chunk');
  if (header.bitDepth !== 8) {
    throw new PngError('png_unsupported', `Only an 8-bit PNG is decoded, this one is ${header.bitDepth}-bit`, { bitDepth: header.bitDepth });
  }
  if (header.interlace !== 0) {
    throw new PngError('png_unsupported', 'An interlaced PNG is not decoded', { interlace: header.interlace });
  }
  const channels = CHANNELS[header.colorType];
  if (!channels) {
    throw new PngError('png_unsupported', `The color type ${header.colorType} is not decoded`, { colorType: header.colorType });
  }
  if (header.colorType === 3 && !palette) {
    throw new PngError('png_invalid', 'A palette PNG has no PLTE chunk');
  }
  if (header.width <= 0 || header.height <= 0) throw new PngError('png_invalid', 'The image has no pixels');
  if (header.width * header.height > maxPixels) {
    throw new PngError('png_unsupported', `The image holds ${header.width * header.height} pixels, above the limit`, { maxPixels });
  }
  if (idat.length === 0) throw new PngError('png_invalid', 'The PNG has no IDAT chunk');

  const bytesPerRow = header.width * channels;
  const expected = header.height * (bytesPerRow + 1);
  let raw;
  try {
    // Bound the inflated output to the size the header demands, so a crafted
    // stream cannot expand past the frame and exhaust memory.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (error) {
    throw new PngError('png_invalid', `The image data did not inflate: ${error.message}`);
  }
  if (raw.length < expected) {
    throw new PngError('png_invalid', `The image data holds ${raw.length} bytes, ${expected} are needed`);
  }

  const rows = unfilter(raw, header.width, header.height, channels, bytesPerRow);
  const rgba = expandToRgba(rows, header.width, header.height, header.colorType, palette ?? Buffer.alloc(0), transparency ?? Buffer.alloc(0));
  return { width: header.width, height: header.height, rgba, colorType: header.colorType };
}

/**
 * A minimal PNG encoder, used by the tests to build frames with known pixels.
 * It writes 8-bit, non-interlaced, and one of the gray or RGB or RGBA color
 * types, with filter type 0 on every scanline.
 *
 * @param {Uint8Array} rgba the pixels, four bytes each
 * @param {number} width
 * @param {number} height
 * @param {number} [colorType] 0 gray, 2 RGB, or 6 RGBA
 */
export function encodePng(rgba, width, height, colorType = 6) {
  const channels = CHANNELS[colorType];
  if (!channels) throw new PngError('png_unsupported', `Cannot encode color type ${colorType}`);
  const bytesPerRow = width * channels;
  const raw = Buffer.alloc(height * (bytesPerRow + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (bytesPerRow + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const target = rowStart + 1 + x * channels;
      if (colorType === 6) {
        raw[target] = rgba[source];
        raw[target + 1] = rgba[source + 1];
        raw[target + 2] = rgba[source + 2];
        raw[target + 3] = rgba[source + 3];
      } else if (colorType === 2) {
        raw[target] = rgba[source];
        raw[target + 1] = rgba[source + 1];
        raw[target + 2] = rgba[source + 2];
      } else {
        raw[target] = rgba[source];
      }
    }
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(width, height, colorType)), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

function ihdr(width, height, colorType) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = colorType;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const body = Buffer.concat([typeBuffer, data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * Build a PNG from already-filtered scanlines. Used by the tests to exercise
 * every scanline filter, and by a caller that holds raw filtered data.
 */
export function encodePngFromRaw(raw, width, height, colorType = 6) {
  if (!CHANNELS[colorType]) throw new PngError('png_unsupported', `Cannot encode color type ${colorType}`);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr(width, height, colorType)), chunk('IDAT', deflateSync(Buffer.from(raw), { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Return a copy of a PNG with the IHDR bit depth or interlace byte patched. */
export function patchIhdr(buffer, { bitDepth, interlace } = {}) {
  const copy = Buffer.from(buffer);
  const dataStart = 16; // signature(8) + length(4) + "IHDR"(4)
  if (bitDepth !== undefined) copy[dataStart + 8] = bitDepth;
  if (interlace !== undefined) copy[dataStart + 12] = interlace;
  const crcStart = dataStart + 13;
  copy.writeUInt32BE(crc32(copy.subarray(dataStart - 4, crcStart)) >>> 0, crcStart);
  return copy;
}
