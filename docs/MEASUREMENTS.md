# Capture measurements

Date: 2026-09-15. Owner: Phygen.

> **Historical record.** This measurement was made with the older 768 x 768
> viewport and the older multi-frame schedule. The current frame is one 1024 x
> 1024 square with seed 1337, and the `capture-check` tool is removed.
>
> Finding 2 below still guides the choice: the network has no visible structure
> at step 300, the first filaments appear near step 1200, and the image is
> saturated near step 3600. The current frame uses step 2500, which is a late
> frame with real structure and a shorter render. Set `PHYGEN_STEP_SCHEDULE` to
> change it. The numbers below are kept as evidence of the machine's speed.

## Machine

| Item | Value |
| --- | --- |
| GPU | NVIDIA GeForce RTX 3090, 24 GB |
| Renderer backend | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 (0x00002204) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Browser | Chrome 153.0.8010.36, headless, `playwright-core` |
| Viewport | 768 × 768, device pixel ratio 1 |
| Artwork | `physarum`, 4000 molds, baseline configuration, seed 1337 |
| Timestep | 8 simulation steps per rendered frame |

Command:

```bash
cd server
npm run capture-check -- --version <versionId> --steps 300,1200,3000,6000 --seeds 1337
```

## Capture duration

| Simulation step | Duration | PNG size | Trail checksum |
| --- | --- | --- | --- |
| 300 | 979 ms | 188 196 B | 207821703 |
| 1200 | 2 718 ms | 317 276 B | 4232262394 |
| 3000 | 6 441 ms | 320 653 B | 501569211 |
| 6000 | 12 700 ms | 324 902 B | 767379521 |

Four frames, sequential: 23 909 ms total, about 6 seconds per frame.

## Findings

1. The cost is linear in the step count, about 2 ms per step at this size.
2. The network has no visible structure at step 300. The first filaments appear
   near step 1200, and the image saturates near step 3600.
3. A schedule of 300 steps or less produces an almost black frame. The
   evaluation schedule is therefore fixed at steps 600, 1800, and 3600 for a
   round, and at 600, 1200, 1800, 2700, and 3600 for a finalist.
4. The trail checksum comes from the simulation, so it measures the artwork and
   not the graphics driver. Compare it separately from image similarity.

## Not yet measured

- Software WebGL on a CPU-only server. The plan requires a result from the
  Hetzner machine. Measure with the container image and `--use-gl=swiftshader`.
- Image differences between two graphics drivers for the same seed and step.
- The capture container: peak memory, wall-clock time, and process limits.
- A real vision comparison. Every judgment in the demonstration comes from the
  deterministic test double, which measures pixels. It is not aesthetic
  judgment and it is not evidence.

## Reproduction

The capture path is deterministic by step count, not by wall-clock time. The
same seed, the same step, and the same configuration give the same trail
checksum on one machine. Run `npm run capture-check` again to confirm.

## Perceptual gate floors

Date: 2026-10-11. Owner: Phygen.

The perceptual gate measures each captured frame and gives it a keep or park
verdict. The floors below were fitted from the chain, so about ninety-five
percent of the known-good frames stay kept.

Command:

```bash
cd server
node tools/calibrate-gate.mjs --json
```

The tool is read-only. It measures every captured frame of one artwork, prints
the score distribution grouped by seed, step, and renderer, and suggests a floor
at the fifth percentile of the kept versions with a bootstrapped interval.

### The measured chain

| Item | Value |
| --- | --- |
| Measured versions | 124 |
| Kept versions | 124 |
| Renderer | `ANGLE (NVIDIA GeForce RTX 3090, D3D11)` |
| Frame | 1024 × 1024, seed 1337, step 1000 |

### Score distributions (kept versions)

| Score | Min | p5 | Median | p95 | Max |
| --- | --- | --- | --- | --- | --- |
| Coherence | 0.192 | 0.270 | 0.336 | 0.634 | 0.680 |
| Novelty | 0.000 | 0.016 | 0.057 | 0.347 | 0.536 |

The coherence interval for the fifth percentile is 0.217 to 0.280. The novelty
interval is 0.000 to 0.023. The novelty is small because each step refines its
parent; a copy of the parent has a novelty near zero.

### Fitted hard-test thresholds

A test that trips on a HIGH value gets a ceiling at the p95 of the kept frames.
A test that trips on a LOW value gets a floor at the p5.

| Threshold | Fitted value | Keeps |
| --- | --- | --- |
| `saturationClipMax` | 0.151 | 95% |
| `uniformEdgeMin` | 0.602 | 95% |
| `uniformEntropyMax` | 0.071 | 95% |
| `emptyOccupiedMin` | 0.054 | 95% |
| `rainbowHueSpreadMax` | 0.891 | 95% |
| `cordRidgeMax` | 1.000 | 100% |

The `cordRidgeMax` ceiling is INACTIVE on this artwork. A healthy physarum frame
is one connected network, so the largest connected component holds a median of
0.998 of the occupied area. The ridge metric cannot separate a network from a
cord here, so the ceiling sits at 1.0 and the test records a skip. A better cord
measure is a separate task.

The `uniform_noise` test needs a high edge density AND a low tonal entropy, so
the p95 edge ceiling and the p5 entropy floor almost never coincide. That test
tripped once in 124 frames.

The ordered-frame `frameDelta` band has no fit: the chain holds no early frame
yet. Capture an early frame and a late frame, then fit the band again.

### Operating point

The fitted values are the defaults in `server/src/config.mjs`. The gate starts in
WARN mode: it records the verdict and parks nothing. The operator turns parking
on with `PHYGEN_GATE_MODE=park` after a warning-only run confirms the verdicts.
