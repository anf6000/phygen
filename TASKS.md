# Phygen Task State

## Current state

The system runs end to end on this machine. One evolution round authors three
candidates, validates them, captures the parent and the candidates in a real
headless browser, compares the images, and promotes a winner or keeps the
parent.

The judgments come from the deterministic TEST DOUBLE, not from a model. No
paid call has been made. Treat every selection in `data/` as a demonstration of
the machinery, not as aesthetic evidence.

## Layout

- `runtime/` — the shared artwork contract, the schema validator, the strict
  configuration loader, the manifest rules, and the Node package checks.
- `threejs/` — the `physarum` artwork package. `manifest.json` declares the
  entry, the editable and protected paths, the pinned dependencies, and the
  limits.
- `server/` — the controller. `src/controller/run.mjs` owns rounds, budgets, and
  selection. `src/providers/` holds the Pi driver and the test double.
  `src/capture/` holds the browser capture and the container worker.
  `src/api/` holds the controller API and the separate artwork origin.
- `web/` — the React, TypeScript, and React Flow interface.
- `docs/` — the API contract, this file's measurements, and the recorded images.
- `snapshots/` — immutable source snapshots. `data/` — records and captures.
  Never edit either by hand.

## Commands

One-time install, run in `web/` and `server/`:

```bash
npm install
```

Run the system, from `server/`:

```bash
npm start                 # API on 8787, artwork origin on 8788
```

Build the interface, from `web/`:

```bash
npm run build             # the controller serves web/dist
```

Checks:

```bash
cd server && npm test               # 14 unit and integration tests
cd threejs && npm test              # 57 artwork package tests
cd threejs && npm run validate      # package validation
cd server && npm run capture-check -- --version <id>   # capture measurement
```

## Safety switches

| Switch | Default | Effect |
| --- | --- | --- |
| `PHYGEN_ALLOW_SPEND` | off | off uses the test double. On permits real model calls. |
| `PHYGEN_DRIVER` | `auto` | `pi`, `fake`, or `auto`. |
| `PHYGEN_CAPTURE` | `auto` | `local`, `docker`, or `auto`. |
| `PHYGEN_ALLOW_UNISOLATED_SOURCE` | off | On runs candidate source code without a container. Do not enable. |
| `PHYGEN_MAX_RUN_USD` | 5 | Highest spending limit a run may ask for. |

## Phase status

| Phase | State |
| --- | --- |
| 1. Feasibility | Half done. Capture is measured on this machine (docs/MEASUREMENTS.md). The vision route through the Kilo provider is unverified. |
| 2. Root package | Complete. |
| 3. One round | Complete against the test double. Real author and judge sessions are unverified. |
| 4. Interface | Complete: tree, viewer, controls, live view, progress events, mobile list. |
| 5. Repeated runs | Partly done. Multi-round runs, pause, resume, stop, branch-from-node, and recovery exist. A second artwork and visual calibration do not. |
| 6. Deployment | Not started. It needs separate approval. |

## Next task

Verify the model route, then run one round with the real provider:

```bash
PHYGEN_ALLOW_SPEND=1 PHYGEN_DRIVER=pi npm start
```

Before you do that, confirm the price of `moonshotai/kimi-k3` in the account and
set `PHYGEN_MAX_RUN_USD` to a bound you accept. The estimates in the interface
are configured bounds, not provider prices.

## Open risks

- Docker Desktop is installed but its service is stopped, so no isolation
  boundary exists. The controller refuses source-code candidates while that is
  true, and the demonstration used configuration-only candidates.
- The capture container image is written but never built or run.
- No browser test of the interface exists. The layout was recorded by hand with
  `tools/ui-shot.mjs`.
- The API has no authentication and no CSRF control. Keep it on the loopback
  address until Phase 6.
- `data/` and `snapshots/` hold demonstration records. Delete them before a real
  run.
