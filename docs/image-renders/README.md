# Artwork image renders

One PNG of every distinct evolved artwork version in this repository, rendered at simulation frame 1000.

## Scope

- The repository evolved one artwork (the physarum package). The base `threejs/` package is byte-identical on all four branches, so the distinct artworks are the published snapshots.
- The snapshots live in the era record stores and in the committed `snapshots/` directory. Each distinct package content hash is one version.
- 544 distinct versions were found: master 142, slotmachine 366, behavior 151, and simple 0.
- `simple` has no committed package snapshots, so it has no images of its own.

Store to branch:
- `backups/baseline-20260917` to master (136 versions)
- `backups/before-prune-20260917` to master (142 versions)
- `backups/before-reset-20260922` to slotmachine (366 versions)
- `backups/before-truncate-20260924` to behavior (64 versions)
- `snapshots` to behavior (122 versions)

## Method
- A small static server serves each package, the shared `runtime/`, and `threejs/node_modules/`.
- Headless Chrome (channel `chrome`) opens each package and waits for the page `__done` signal.
- Render parameters: `steps=1000`, `speed=8`, `paused=0`, `dpr=1`; viewport 2048 by 2048; device scale factor 1.
- Every version uses its own fresh random seed. The seed is stored in `progress.json` and `index.json`, so each image can be reproduced.
- Rendering is GPU-backed (ANGLE, NVIDIA RTX 3090, Direct3D 11). The runner is concurrent and resumable.
- The tool that produced these images is `tools/render/render-artworks.mjs`; its plan is `tools/render/artwork-plan.json`.

## Output
- `master/`, `simple/`, `slotmachine/`, `behavior/`: one PNG per version, named in creation order.
- File name: `<index>_<YYYY-MM-DD_HHMMSS>_<hash12>.png`. The index numbers each branch folder from `001` in creation order. Times are UTC (`Z`).
- The index comes from each version's `snapshot.json` marker (`createdAt`), not from the file system clock. Versions that failed to render keep their position, so a branch folder can have a gap in its numbering.
- A version that appears in more than one era store is rendered once and hardlinked into each branch folder, so identical images share one file.
- `index.json`: metadata for every rendered version (hash, `createdAt`, branches, stores, seed, num, palette, per-branch file name and order, render time).
- `progress.json`: the live done and failed state. `render.log`: the run log.

## Result

- Rendered: **534 of 544** versions at 2048 by 2048.
- Branch folders: master 142, slotmachine 359, behavior 148, simple 0.
- Output on disk: 671 PNG files, about 1.65 GB, including the `selected/` copies.
- Creation range: 2026-09-16T06:20:32.902Z to 2026-09-25T02:47:01.523Z (UTC).
- Failed: **10**.

The failures are broken evolved versions, not renderer faults:

| hash | branch | reason |
| --- | --- | --- |
| `36a8dec4e5c2` | behavior | Cannot access 'nov' before initialization |
| `3f20643c2d16` | slotmachine | stuck during initialization (no state after 10 minutes) |
| `4bb69855a70c` | behavior | blind is not defined |
| `8dc0a3fcbb1d` | slotmachine | rt is not defined |
| `b8b10068ada0` | slotmachine | dirX is not defined |
| `ca37f38df698` | slotmachine | Cannot access 'coh' before initialization |
| `d7d7492b748c` | slotmachine | stuck during initialization (no state after 10 minutes) |
| `d9ca8b97f6e5` | slotmachine | stuck during initialization (no state after 10 minutes) |
| `e3eeb57aa60e` | slotmachine | stuck during initialization (no state after 10 minutes) |
| `f1b3381f680c` | behavior | Cannot access 'surf' before initialization |

Six versions stop with a JavaScript error in their own source (`nov`, `blind`, `rt`, `dirX`, `coh`, `surf`). Four versions never finish initialization and produce no state. All ten are recorded in `progress.json` and listed in `index.json` under `failedVersions`.

## Notes
- Frame 1000 is a fixed simulation step. It is not necessarily the artwork's final or preferred state.
- Branch attribution follows the era store where a version was recorded. Because the branches are a linear line of work, later stores also hold earlier versions, so a version can appear under more than one branch.
- The base `threejs/` package render is not included, because it is identical on every branch.
