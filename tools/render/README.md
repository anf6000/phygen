# Artwork renderer

Render each evolved artwork version at simulation frame 1000 into `docs/image-renders`.

## What it does

- Reads `tools/render/artwork-plan.json`. Each row is one distinct package content hash.
- Serves each package together with the shared runtime and the three.js files.
- Opens the artwork in headless Chrome and waits for the page `done` signal.
- Saves one PNG at the requested size.
- Names each file `NNN_YYYY-MM-DD_HHMMSS_hash12.png`, numbered from `001` in creation order.
- Writes state to `docs/image-renders/progress.json`, `index.json`, and `render.log`.

A version that appears in more than one era store is written into each branch folder.
A name that exists in a branch `selected/` folder is refreshed with the same render.

## Run

```
node tools/render/render-artworks.mjs
```

Environment:

- `RENDER_SIZE`: output size in pixels. Default `2048`.
- `RENDER_CONCURRENCY`: parallel renders. Default `6`.
- `RENDER_LIMIT`: render only the first N pending versions. Default `0` (all).
- `RENDER_TIMEOUT_SECONDS`: time limit for one render. Default `2400`.

The run is resumable. Start it again to continue.

## Frame and seed

Each version renders at simulation step 1000. The animation speed does not change the
result of a fixed step count.

Every version uses its own fresh random seed. The seed is stored in `progress.json`
and in `index.json`, so the image can be reproduced.

## Requirements

- Google Chrome at the default install path, for `playwright-core` (`channel: chrome`).
- `server/node_modules/playwright-core`.

## Plan file

`artwork-plan.json` holds one row per version: `hash`, `package` (relative to the
repository root), `stores`, `branches`, `seed`, `num`, `palette`, and `createdAt`.
