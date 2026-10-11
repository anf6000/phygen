// ─────────────────────────────────────────────────────────────────────────────
// tests.mjs — the hard park tests. A step that trips one is refused, whatever
// the coherence and the novelty say.
//
// Every test reads measured features and returns a value, the floor it was held
// to, and whether it tripped. A test that could not run (no early frame for the
// ordered-frame test) is marked `available: false`; the caller records a skip,
// and a skip is NEVER a pass and never a zero.
// ─────────────────────────────────────────────────────────────────────────────
import { frameDelta } from './distance.mjs';

/**
 * The library default floors, used only by a caller that passes none.
 *
 * The server does not use these: `config.gate.floors` is the single runtime
 * owner, and its values are fitted from the chain (docs/MEASUREMENTS.md). These
 * defaults keep a direct caller and the tests self-contained.
 */
export const DEFAULT_FLOORS = Object.freeze({
  saturationClipMax: 0.35,
  uniformEdgeMin: 0.5,
  uniformEntropyMax: 0.35,
  emptyOccupiedMin: 0.015,
  cordRidgeMax: 0.85,
  rainbowHueSpreadMax: 0.85,
  frameDeltaMin: 0.004,
  frameDeltaMax: 0.8,
});

/**
 * Run every hard test on one frame.
 *
 * @param {object} options
 * @param {object} options.features the frame features, from `measureFrame`
 * @param {object} [options.early]  the early frame features, for the ordered-frame test
 * @param {object} [options.floors]
 * @returns {{tests: object[], tripped: string[], available: boolean}}
 */
export function runHardTests({ features, early = null, floors = {} }) {
  const f = { ...DEFAULT_FLOORS, ...floors };
  const tests = [];
  const add = (name, tripped, value, floor, note, available = true) => {
    tests.push({ name, tripped: Boolean(tripped), value, floor, note, available });
  };

  add(
    'saturation_clipping',
    features.saturationClipFraction > f.saturationClipMax,
    features.saturationClipFraction,
    f.saturationClipMax,
    'too many pixels hold a maximum channel value',
  );

  add(
    'uniform_noise',
    features.edgeDensity > f.uniformEdgeMin && features.luminanceEntropy < f.uniformEntropyMax,
    { edgeDensity: features.edgeDensity, luminanceEntropy: features.luminanceEntropy },
    { edgeDensity: f.uniformEdgeMin, luminanceEntropy: f.uniformEntropyMax },
    'dense edges with almost no tonal variety',
  );

  const empty = features.occupiedFraction < f.emptyOccupiedMin;
  const cord = features.dominantRidgeShare > f.cordRidgeMax;
  add(
    'empty_or_cord',
    empty || cord,
    { occupiedFraction: features.occupiedFraction, dominantRidgeShare: features.dominantRidgeShare },
    { occupiedFraction: f.emptyOccupiedMin, dominantRidgeShare: f.cordRidgeMax },
    empty ? 'too little of the frame is occupied' : 'one cord holds almost all of the occupied area',
  );

  add('rainbow', features.hueSpread > f.rainbowHueSpreadMax, features.hueSpread, f.rainbowHueSpreadMax, 'the hues span the whole color wheel');

  if (early) {
    const delta = frameDelta(early, features);
    add(
      'strobing',
      delta < f.frameDeltaMin || delta > f.frameDeltaMax,
      delta,
      { min: f.frameDeltaMin, max: f.frameDeltaMax },
      delta < f.frameDeltaMin ? 'the frame did not develop between the ordered frames' : 'the frame changed too far between the ordered frames',
    );
  } else {
    add('strobing', false, null, { min: f.frameDeltaMin, max: f.frameDeltaMax }, 'the early frame was not measured, so this test did not run', false);
  }

  const tripped = tests.filter((test) => test.tripped).map((test) => test.name);
  return { tests, tripped, available: tests.every((test) => test.available) };
}
