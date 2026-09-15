# Capture measurements

Date: 2026-09-15. Owner: Phygen.

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
