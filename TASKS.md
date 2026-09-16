# Phygen Task State

## Current state

The system runs end to end with the REAL model. The first paid round promoted a
candidate for 0.515 USD.

Vocabulary, which the interface, the API, and the records use:

- A **variant** is one child version that a parent spawns.
- An **evolution** is one level. The level creates its variants, then the winner
  of that level becomes the parent of the next level.

So two variants over two evolutions makes two children of the selected version,
then two grandchildren of the winner.

The **selected version spawns the variants**. There is no separate step: select a
version in the tree, press Start, and the children appear under it. The selection
and the run settings survive a browser refresh.

**No cost guardrail is enforced.** The estimate is shown, the real provider cost
is recorded, and a run is never refused or stopped for money. Set
`PHYGEN_MAX_RUN_USD` to a positive value only if you want a limit.

To spend money you must set `PHYGEN_ALLOW_SPEND=1` and `PHYGEN_DRIVER=pi`. A run
made with `PHYGEN_DRIVER=fake` is marked `stub: true` in every comparison, and
its verdicts are not evidence.

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
node tools/ui-check.mjs     # the selection survives a reload; writes a tree image
node tools/pages-shot.mjs   # one image of every page
```

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PHYGEN_ALLOW_SPEND` | unset | Model calls are refused until this is `1`. |
| `PHYGEN_DRIVER` | `auto` | `pi`, `fake`, or `auto`. |
| `PHYGEN_MODEL` | `moonshotai/kimi-k3` | The judge model. |
| `PHYGEN_AUTHOR_MODEL` | as above | The author model. |
| `PHYGEN_VARIANTS` | `3` | Default children per evolution. |
| `PHYGEN_MAX_RUN_USD` | `0` | A cost limit. `0` enforces none. |
| `PHYGEN_COST_SAFETY_FACTOR` | `1.8` | The reserve is this multiple of the estimate. |
| `PHYGEN_REQUIRE_ISOLATION` | `0` | `1` refuses source candidates without a container. |
| `PHYGEN_CAPTURE` | `auto` | `local`, `docker`, or `auto`. |
| `PHYGEN_BROWSER_EXECUTABLE` | unset | The Chromium path on a server. |
| `PHYGEN_PI_ENTRY` | unset | The Pi CLI entry. Required on Windows, where the `pi` command is a .cmd shim. |
| `PHYGEN_AUTHOR_THINKING` | `low` | Author effort. `minimal` is much faster. |
| `PHYGEN_SESSION_TIMEOUT_MS` | `1800000` | Limit for one author session. |
| `PHYGEN_CLEANUP_WORKSPACES` | `1` | Remove candidate workspaces when a run ends. |

## Live work visualisation

The interface shows what a session does while it works. The source is the Pi
JSON event stream: `tool_execution_start` carries the tool name and its
arguments, so an `edit` gives the changed text and a `write` gives the
content, `tool_execution_end` says whether it failed, `message_update` gives
the assistant text as it arrives, and `turn_end` gives the tokens and cost.

The controller maps those events to `agent` rows on the run stream, and stores
them in the `events` table. `GET /api/versions/:versionId/agent` returns the
stored feed of one version, so a finished version still shows how it was made.
A version created before this feature has no feed history.

The node shows the newest captured frame while a capture runs, and a decision
badge (WINNER! or YEETED!) appears over the nodes when the round ends.

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

- A server restart PAUSES every in-flight run on purpose, because a paid request may have been accepted. Resume it from the interface. This happened twice during development.

- The Pi child process needs its standard input closed. An open pipe makes it wait forever. `server/src/providers/pi.mjs` sets this.
- Source-code candidates run in the sandboxed artwork page, not in a container.
  Set `PHYGEN_REQUIRE_ISOLATION=1` on a server, and build the capture image
  (`server/docker/Dockerfile`) for the stronger boundary. The image is untested.
- The container backend and the Dockerfile are unverified on this machine.
- The API has no authentication and no CSRF control. Keep it on the loopback
  address until Phase 6.
- `data/` and `snapshots/` hold demonstration records. Delete them before a real
  run.
