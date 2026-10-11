// The PNG decoder: the metric path depends on it, so a wrong pixel is a wrong
// measurement. Every case asserts either exact pixels or a recorded skip.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodePng, encodePng, encodePngFromRaw, isPng, patchIhdr, PngError } from '../src/vision/png.mjs';

function rgbaOf(pixels) {
  const buffer = new Uint8Array(pixels.length * 4);
  pixels.forEach((pixel, index) => {
    buffer[index * 4] = pixel[0];
    buffer[index * 4 + 1] = pixel[1];
    buffer[index * 4 + 2] = pixel[2];
    buffer[index * 4 + 3] = pixel.length > 3 ? pixel[3] : 255;
  });
  return buffer;
}

function pixelAt(decoded, x, y) {
  const index = (y * decoded.width + x) * 4;
  return [decoded.rgba[index], decoded.rgba[index + 1], decoded.rgba[index + 2], decoded.rgba[index + 3]];
}

test('a PNG round-trips every pixel exactly', () => {
  const pixels = [
    [10, 20, 30],
    [40, 50, 60],
    [70, 80, 90],
    [100, 110, 120, 64],
    [130, 140, 150],
    [160, 170, 180],
  ];
  const width = 3;
  const height = 2;
  const png = encodePng(rgbaOf(pixels), width, height, 6);

  assert.equal(isPng(png), true);
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  pixels.forEach((pixel, index) => {
    assert.deepEqual(pixelAt(decoded, index % width, Math.floor(index / width)), [pixel[0], pixel[1], pixel[2], pixel[3] ?? 255]);
  });
});

test('an RGB PNG decodes to opaque RGBA', () => {
  const png = encodePng(rgbaOf([[1, 2, 3], [4, 5, 6]]), 2, 1, 2);
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(pixelAt(decoded, 1, 0), [4, 5, 6, 255]);
});

test('a gray PNG copies its one channel to red, green, and blue', () => {
  const png = encodePng(rgbaOf([[9, 0, 0], [200, 0, 0]]), 2, 1, 0);
  const decoded = decodePng(png);
  assert.deepEqual(pixelAt(decoded, 0, 0), [9, 9, 9, 255]);
  assert.deepEqual(pixelAt(decoded, 1, 0), [200, 200, 200, 255]);
});

test('the decoder reverses every scanline filter', () => {
  // A 2x2 gray image with the pixels [10, 20] and [30, 40]. Each row is filtered
  // by hand; the decoder must reproduce the original values.
  const cases = [
    // filter Sub then Up
    Uint8Array.from([1, 10, 10, 2, 20, 20]),
    // filter Average then Paeth
    Uint8Array.from([3, 10, 15, 4, 20, 10]),
  ];
  for (const raw of cases) {
    const decoded = decodePng(encodePngFromRaw(raw, 2, 2, 0));
    assert.deepEqual(pixelAt(decoded, 0, 0), [10, 10, 10, 255]);
    assert.deepEqual(pixelAt(decoded, 1, 0), [20, 20, 20, 255]);
    assert.deepEqual(pixelAt(decoded, 0, 1), [30, 30, 30, 255]);
    assert.deepEqual(pixelAt(decoded, 1, 1), [40, 40, 40, 255]);
  }
});

test('a 16-bit PNG is a recorded skip, not a silent zero', () => {
  const png = patchIhdr(encodePng(rgbaOf([[1, 2, 3]]), 1, 1, 6), { bitDepth: 16 });
  assert.throws(() => decodePng(png), (error) => error instanceof PngError && error.code === 'png_unsupported');
});

test('an interlaced PNG is a recorded skip', () => {
  const png = patchIhdr(encodePng(rgbaOf([[1, 2, 3]]), 1, 1, 6), { interlace: 1 });
  assert.throws(() => decodePng(png), (error) => error instanceof PngError && error.code === 'png_unsupported');
});

test('a bad signature and a bad checksum are refused', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), (error) => error instanceof PngError && error.code === 'png_invalid');
  const png = encodePng(rgbaOf([[1, 2, 3]]), 1, 1, 6);
  const broken = Buffer.from(png);
  broken[broken.length - 1] ^= 0xff;
  assert.throws(() => decodePng(broken), (error) => error instanceof PngError && error.code === 'png_invalid');
});

test('an image above the pixel limit is refused', () => {
  const png = encodePng(rgbaOf([[1, 2, 3], [4, 5, 6]]), 2, 1, 6);
  assert.throws(() => decodePng(png, { maxPixels: 1 }), (error) => error.code === 'png_unsupported');
});
