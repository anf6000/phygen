# Phygen Task State

## Current state

The system runs end to end on this machine. One evolution round authors three
candidates, each writes new code, the controller validates and snapshots them,
captures the parent and the candidates in a real headless browser, compares the
images, and promotes a winner or keeps the parent.

The judgments in `data/` come from the deterministic TEST DOUBLE, not from a
model. No paid call has been made. Treat those selections as a demonstration of
the machinery, not as aesthetic evidence.

## Commands

Install once, in `server/` and `web/`:

```bash
npm install
```

Run the system, from `server/`:

```bash
npm start                 # API and interface on 8787, artwork origin on 8788
```

Open <http://127.0.0.1:8787/>.

Checks:

```bash
cd server && npm test       # 14 controller tests, including one full round
cd threejs && npm test      # 57 artwork tests
cd threejs && npm run validate
cd server && npm run capture-check -- --version <id>   # capture measurement
node tools/live-check.mjs   # the live artwork on both routes
node tools/pages-shot.mjs   # one image of every page
```

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PHYGEN_ALLOW_SPEND` | unset | Model calls are refused until this is `1`. |
| `PHYGEN_DRIVER` | `auto` | `pi`, `fake`, or `auto`. |
| `PHYGEN_MODEL` | `moonshotai/kimi-k3` | The judge model. |
| `PHYGEN_AUTHOR_MODEL` | as above | The author model. |
| `PHYGEN_MAX_RUN_USD` | `5` | The highest limit a run may ask for. |
| `PHYGEN_COST_SAFETY_FACTOR` | `1.8` | The reserve is this multiple of the estimate. |
| `PHYGEN_REQUIRE_ISOLATION` | `0` | `1` refuses source candidates without a container. |
| `PHYGEN_CAPTURE` | `auto` | `local`, `docker`, or `auto`. |
| `PHYGEN_BROWSER_EXECUTABLE` | unset | The Chromium path on a server. |
| `PHYGEN_CLEANUP_WORKSPACES` | `1` | Remove candidate workspaces when a run ends. |

## Layout

- `runtime/` — the shared artwork contract, the schema validator, the strict
  configuration loader, the manifest rules, and the Node package checks.
- `threejs/` — the `physarum` artwork package.
- `server/` — the controller. `src/controller/run.mjs` owns rounds, budgets, and
  selection. `src/providers/` holds the Pi driver and the test double.
  `src/capture/` holds the browser capture and the container worker.
  `src/api/` holds the controller API and the separate artwork origin.
- `web/` — the React, TypeScript, and React Flow interface.
- `docs/` — the API contract, the measurements, the flow diagram, and images.
- `data/`, `snapshots/` — records, captures, and immutable snapshots. Not source.

## Phase status

| Phase | State |
| --- | --- |
| 1. Feasibility | Capture is measured on this machine (docs/MEASUREMENTS.md). The vision route through the Kilo provider is unverified. |
| 2. Root package | Complete. |
| 3. One round | Complete against the test double. Real author and judge sessions are unverified. |
| 4. Interface | Complete: top-down tree, placeholders for work in progress, record panel, frame viewer, live view, model pickers, progress events, mobile list. |
| 5. Repeated runs | Partly done. Multi-round runs, pause, resume, stop, branch-from-node, and restart recovery exist. A second artwork and visual calibration do not. |
| 6. Deployment | Not started. It needs separate approval. |

## Next task

Verify the model route, then run one round with the real provider:

```bash
PHYGEN_ALLOW_SPEND=1 PHYGEN_DRIVER=pi npm start
```

Confirm the price of `moonshotai/kimi-k3` in the account first, and set
`PHYGEN_MAX_RUN_USD` to a bound you accept. The prices in the interface come from
the Kilo catalog; provider usage is authoritative.

## Open risks

- No model judged anything yet. Every verdict in `data/` is marked `stub: true`.
- Source-code candidates run in the sandboxed artwork page, not in a container.
  Set `PHYGEN_REQUIRE_ISOLATION=1` on a server, and build the capture image
  (`server/docker/Dockerfile`) for the stronger boundary. The image is untested.
- The container backend and the Dockerfile are unverified on this machine.
- The API has no authentication and no CSRF control. Keep it on the loopback
  address until Phase 6.
- `data/` and `snapshots/` hold demonstration records. Delete them before a real
  run.
