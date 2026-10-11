// ─────────────────────────────────────────────────────────────────────────────
// metrics.mjs — free image features, measured on the captured PNG.
//
// Every function is pure: it reads one RGBA buffer and returns numbers. There is
// no model, no clock, no file, and no random source, so the same frame always
// gives the same features and a recorded score can be reproduced.
//
// Luminance is the sRGB luma from the ITU-R BT.709 weights, kept in 0..1. Hue is
// a circular quantity, so its spread uses the mean resultant length and never a
// plain variance.
// ─────────────────────────────────────────────────────────────────────────────

/** Hubble/ITU-R BT.709 luma weights. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** The canonical Hasler–Süsstrunk colorfulness is around this value for a vivid image. */
export const COLORFULNESS_REFERENCE = 110;

const HUE_BINS = 8;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A Float32 luminance plane in 0..1, one value per pixel. */
export function luminancePlane(rgba, pixels) {
  const luma = new Float32Array(pixels);
  for (let index = 0; index < pixels; index++) {
    const at = index * 4;
    luma[index] = (LUMA_R * rgba[at] + LUMA_G * rgba[at + 1] + LUMA_B * rgba[at + 2]) / 255;
  }
  return luma;
}

/**
 * Hasler–Süsstrunk colorfulness: the spread and the offset of the two
 * opponent-color axes, in the image's own 0..255 units.
 */
export function colorfulness(rgba, pixels) {
  let sumRg = 0;
  let sumYb = 0;
  let sumRg2 = 0;
  let sumYb2 = 0;
  for (let index = 0; index < pixels; index++) {
    const at = index * 4;
    const r = rgba[at];
    const g = rgba[at + 1];
    const b = rgba[at + 2];
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    sumRg += rg;
    sumYb += yb;
    sumRg2 += rg * rg;
    sumYb2 += yb * yb;
  }
  const n = Math.max(1, pixels);
  const meanRg = sumRg / n;
  const meanYb = sumYb / n;
  const varRg = Math.max(0, sumRg2 / n - meanRg * meanRg);
  const varYb = Math.max(0, sumYb2 / n - meanYb * meanYb);
  return Math.sqrt(varRg + varYb) + 0.3 * Math.sqrt(meanRg * meanRg + meanYb * meanYb);
}

/** The share of pixels whose largest channel sits at the maximum value. */
export function saturationClipFraction(rgba, pixels) {
  let clipped = 0;
  for (let index = 0; index < pixels; index++) {
    const at = index * 4;
    if (rgba[at] >= 255 || rgba[at + 1] >= 255 || rgba[at + 2] >= 255) clipped++;
  }
  return pixels === 0 ? 0 : clipped / pixels;
}

/** Shannon entropy of the luminance histogram, normalized to 0..1. */
export function luminanceEntropy(luma, bins = 256) {
  const histogram = new Uint32Array(bins);
  for (let index = 0; index < luma.length; index++) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(luma[index] * bins)));
    histogram[bin]++;
  }
  let entropy = 0;
  const n = luma.length || 1;
  for (let bin = 0; bin < bins; bin++) {
    if (histogram[bin] === 0) continue;
    const p = histogram[bin] / n;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.min(bins, n));
  return maxEntropy === 0 ? 0 : clamp01(entropy / maxEntropy);
}

/**
 * Sobel edges over the luminance plane.
 *
 * @returns {{density: number, balance: number, meanMagnitude: number}}
 *   density: the share of pixels whose gradient clears the threshold
 *   balance: the normalized spread of gradient directions, 0 when all edges
 *            share a direction and 1 when they are evenly spread
 */
export function sobelEdges(luma, width, height, magnitudeThreshold) {
  const orientation = new Float64Array(HUE_BINS);
  let edges = 0;
  let total = 0;
  let sumMagnitude = 0;
  if (width < 3 || height < 3) return { density: 0, balance: 0, meanMagnitude: 0 };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const tl = luma[at - width - 1];
      const t = luma[at - width];
      const tr = luma[at - width + 1];
      const l = luma[at - 1];
      const r = luma[at + 1];
      const bl = luma[at + width - 1];
      const b = luma[at + width];
      const br = luma[at + width + 1];
      const gx = tr + 2 * r + br - (tl + 2 * l + bl);
      const gy = bl + 2 * b + br - (tl + 2 * t + tr);
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      sumMagnitude += magnitude;
      total++;
      if (magnitude <= magnitudeThreshold) continue;
      edges++;
      let angle = Math.atan2(gy, gx);
      if (angle < 0) angle += Math.PI;
      const bin = Math.min(HUE_BINS - 1, Math.floor((angle / Math.PI) * HUE_BINS));
      orientation[bin] += magnitude;
    }
  }

  let balance = 0;
  if (edges > 0) {
    let weighted = 0;
    for (let bin = 0; bin < HUE_BINS; bin++) weighted += orientation[bin];
    let entropy = 0;
    for (let bin = 0; bin < HUE_BINS; bin++) {
      if (orientation[bin] === 0) continue;
      const p = orientation[bin] / weighted;
      entropy -= p * Math.log2(p);
    }
    balance = clamp01(entropy / Math.log2(HUE_BINS));
  }
  return { density: total === 0 ? 0 : edges / total, balance, meanMagnitude: total === 0 ? 0 : sumMagnitude / total };
}

/**
 * The occupied share: the pixels that differ from the frame's own background.
 *
 * The background is the most common color, found on a 4-bit-per-channel
 * quantized histogram. A frame that is one flat color is fully background.
 *
 * @returns {{occupiedFraction: number, background: number[], occupiedPixels: number, mask: Uint8Array}}
 */
export function occupiedStats(rgba, width, height, differenceThreshold = 0.09) {
  const pixels = width * height;
  const bins = new Int32Array(4096);
  for (let index = 0; index < pixels; index++) {
    const at = index * 4;
    const key = ((rgba[at] >> 4) << 8) | ((rgba[at + 1] >> 4) << 4) | (rgba[at + 2] >> 4);
    bins[key]++;
  }
  let bestKey = 0;
  let bestCount = -1;
  for (let key = 0; key < 4096; key++) {
    if (bins[key] > bestCount) {
      bestCount = bins[key];
      bestKey = key;
    }
  }
  const background = [((bestKey >> 8) & 0xf) << 4 | 8, ((bestKey >> 4) & 0xf) << 4 | 8, (bestKey & 0xf) << 4 | 8];
  const limit = differenceThreshold * 255;
  const mask = new Uint8Array(pixels);
  let occupiedPixels = 0;
  for (let index = 0; index < pixels; index++) {
    const at = index * 4;
    const diff = Math.max(
      Math.abs(rgba[at] - background[0]),
      Math.abs(rgba[at + 1] - background[1]),
      Math.abs(rgba[at + 2] - background[2]),
    );
    if (diff > limit) {
      mask[index] = 1;
      occupiedPixels++;
    }
  }
  return { occupiedFraction: pixels === 0 ? 0 : occupiedPixels / pixels, background, occupiedPixels, mask };
}

/**
 * The share of occupied area held by the largest connected component.
 *
 * The mask is downsampled to a coarse grid first, so the cost does not grow with
 * the frame and a fine speckle does not dominate.
 */
export function dominantRidgeShare(mask, width, height, grid = 64) {
  const cols = Math.min(grid, width);
  const rows = Math.min(grid, height);
  const coarse = new Uint8Array(cols * rows);
  let occupiedCells = 0;
  for (let cy = 0; cy < rows; cy++) {
    const y0 = Math.floor((cy * height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / rows));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cols));
      let any = false;
      for (let y = y0; y < y1 && !any; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          if (mask[row + x]) {
            any = true;
            break;
          }
        }
      }
      if (any) {
        coarse[cy * cols + cx] = 1;
        occupiedCells++;
      }
    }
  }
  if (occupiedCells === 0) return 0;

  // Largest 4-connected component on the coarse grid, by iterative flood fill.
  const seen = new Uint8Array(cols * rows);
  let largest = 0;
  const stack = [];
  for (let start = 0; start < coarse.length; start++) {
    if (!coarse[start] || seen[start]) continue;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop();
      size++;
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      if (cx > 0 && coarse[cell - 1] && !seen[cell - 1]) {
        seen[cell - 1] = 1;
        stack.push(cell - 1);
      }
      if (cx < cols - 1 && coarse[cell + 1] && !seen[cell + 1]) {
        seen[cell + 1] = 1;
        stack.push(cell + 1);
      }
      if (cy > 0 && coarse[cell - cols] && !seen[cell - cols]) {
        seen[cell - cols] = 1;
        stack.push(cell - cols);
      }
      if (cy < rows - 1 && coarse[cell + cols] && !seen[cell + cols]) {
        seen[cell + cols] = 1;
        stack.push(cell + cols);
      }
    }
    if (size > largest) largest = size;
  }
  return largest / occupiedCells;
}

/**
 * Circular hue spread in 0..1.
 *
 * 0 means every saturated pixel shares one hue; 1 means the hues are evenly
 * spread over the wheel, which is what a full-spectrum rainbow looks like.
 */
export function hueSpread(rgba, pixels, minimumSaturation = 0.2) {
  let sumCos = 0;
  let sumSin = 0;
  let count = 0;
  for (let index = 0; index < pixels; index++) {
    const at = index * 4;
    const r = rgba[at] / 255;
    const g = rgba[at + 1] / 255;
    const b = rgba[at + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (max <= 0 || delta / max < minimumSaturation) continue;
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= Math.PI / 3;
    sumCos += Math.cos(hue);
    sumSin += Math.sin(hue);
    count++;
  }
  if (count === 0) return 0;
  const resultant = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / count;
  return clamp01(1 - resultant);
}

/** A normalized 16-bin luminance histogram, for distances. */
export function coarseHistogram(luma, bins = 16) {
  const histogram = new Float32Array(bins);
  for (let index = 0; index < luma.length; index++) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(luma[index] * bins)));
    histogram[bin] += 1;
  }
  const n = luma.length || 1;
  for (let bin = 0; bin < bins; bin++) histogram[bin] /= n;
  return histogram;
}

/** A 16x16 average-luminance block map, for distances. */
export function blockMap(luma, width, height, grid = 16) {
  const map = new Float32Array(grid * grid);
  const counts = new Float32Array(grid * grid);
  const columns = new Uint16Array(width);
  for (let x = 0; x < width; x++) columns[x] = Math.min(grid - 1, Math.floor((x * grid) / width));
  for (let y = 0; y < height; y++) {
    const rowBase = Math.min(grid - 1, Math.floor((y * grid) / height)) * grid;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const at = rowBase + columns[x];
      map[at] += luma[rowStart + x];
      counts[at]++;
    }
  }
  for (let at = 0; at < map.length; at++) if (counts[at] > 0) map[at] /= counts[at];
  return map;
}

/**
 * A slim measurement: only the luma plane and the coarse block map.
 *
 * The ordered-frame test reads one field of the early frame, so the early frame
 * does not need the full feature set. This keeps the second frame cheap.
 */
export function measureBlockMap(frame, { blockGrid = 16 } = {}) {
  const { width, height, rgba } = frame;
  const luma = luminancePlane(rgba, width * height);
  return { blockMap: Array.from(blockMap(luma, width, height, blockGrid)) };
}

const DEFAULT_OPTIONS = Object.freeze({
  occupiedThreshold: 0.09,
  saturationClipInfluence: false,
  edgeMagnitudeThreshold: 0.08,
  hueMinSaturation: 0.2,
  ridgeGrid: 64,
  histogramBins: 16,
  blockGrid: 16,
});

/**
 * Measure every free feature of one frame.
 *
 * @param {{width: number, height: number, rgba: Uint8Array}} frame
 * @param {object} [options]
 * @returns {object} the features, plus a normalized `colorfulness01`
 */
export function measureFrame(frame, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const { width, height, rgba } = frame;
  const pixels = width * height;
  const luma = luminancePlane(rgba, pixels);
  const occupancy = occupiedStats(rgba, width, height, config.occupiedThreshold);
  const edges = sobelEdges(luma, width, height, config.edgeMagnitudeThreshold);
  const raw = colorfulness(rgba, pixels);
  return {
    width,
    height,
    pixels,
    colorfulnessRaw: raw,
    colorfulness: clamp01(raw / COLORFULNESS_REFERENCE),
    saturationClipFraction: saturationClipFraction(rgba, pixels),
    luminanceEntropy: luminanceEntropy(luma),
    edgeDensity: edges.density,
    edgeBalance: edges.balance,
    edgeMagnitude: edges.meanMagnitude,
    occupiedFraction: occupancy.occupiedFraction,
    occupiedPixels: occupancy.occupiedPixels,
    background: occupancy.background,
    dominantRidgeShare: dominantRidgeShare(occupancy.mask, width, height, config.ridgeGrid),
    hueSpread: hueSpread(rgba, pixels, config.hueMinSaturation),
    histogram: Array.from(coarseHistogram(luma, config.histogramBins)),
    blockMap: Array.from(blockMap(luma, width, height, config.blockGrid)),
  };
}
