# Phygen Task State

## Current state

The system runs a **forward chain** with the real model. One run makes a chain of
child versions, one child per step, and the interface is read-only.

The step instruction now tells the session to **write no code comments** and to
**favor bold colors**.

A **refactor** is a one-time operator cleanup, never part of evolution. The step
loop never calls it. Run it by hand:

```bash
cd server && node tools/repair-version.mjs --version <id> --refactor
```

It refuses to keep a result that changes the artwork: a frame is captured before
and after, and the version is updated only when the trail checksum is unchanged.
A changed `config.json` is refused too. Applied once on 2026-09-19 to step 50:
both source files lost every comment (4900 lines to 3320), and the trail checksum
stayed `3998659443`.

Vocabulary, which the interface, the API, and the records use:

- A **step** makes exactly one child of the newest good version.
- The **chain head** is the newest version with status `promoted`. A step always
  starts from the chain head.
- A **run** asks for X steps. The run reads the chain head again before every
  step, so a failed step never becomes a parent.
- There is **no judge, no comparison, no variant, and no archive**. The child is
  always kept. A person judges quality by looking at the frames.

The chain is linear. Every child has one parent, so the version count is
`1 + evolutionsDone + failed steps`.

The root is the imported mother. Its frame is captured in the background when the
artwork is imported, so its card shows a real frame and never the loading art.

A failed step stays failed, and the chain head stays. An operator can repair one
failed version: `node tools/repair-version.mjs --version <id>` starts from that
version's OWN published snapshot, runs one repair session, then validates,
publishes, captures, and keeps it. `POST /api/versions/:id/repair` does the same.
That is the only path from `failed` back to `promoted`.

**No cost guardrail is enforced.** The estimate is shown, the real provider cost
is recorded, and a run is never refused or stopped for money. Set
`PHYGEN_MAX_RUN_USD` to a positive value only if you want a limit. A configured
limit that refuses a request stops the run; it does not consume a step and it
does not look like a candidate fault.

To spend money you must set `PHYGEN_ALLOW_SPEND=1` and `PHYGEN_DRIVER=pi`. A run
made with `PHYGEN_DRIVER=fake` carries the **test double** chip on every card, and
its frames are not evidence.

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
cd server && npm test       # 39 controller, step loop, and storage tests
cd threejs && npm test      # 57 artwork tests
cd web && npm test          # 13 chain-order, label, autoplay, and pixel-motion tests
cd threejs && npm run validate
cd web && npm run build
cd server && node tools/snapshot-report.mjs            # snapshot integrity report
cd server && node tools/backup.mjs --out <dir>         # consistent backup
cd server && node tools/clear-stale-jobs.mjs           # close records left in flight
node tools/live-check.mjs --version <id>               # the live artwork on both routes
```

## One step

A step does these actions, in order:

1. Read the chain head.
2. Create the child row and copy the parent package into
   `data-evolve/workspaces/<runId>/<versionId>/`.
3. Run one author session with the fixed instruction. The session sees the last
   three frames of the chain, newest first, and the history of this run.
4. Review the edits against the manifest, and check the package and the
   configuration. A technical failure gets one bounded repair session.
5. Publish the snapshot.
6. Capture one late square frame: 1024 x 1024, seed 1337, step 2500.
7. Promote the child.

A technical failure after the repair marks the version `failed`, keeps the chain
head, and the next step starts from the last good version.

A failed step is **NOT shown** in the interface: the chain is the record of the
work that was kept, and a refusal is not a step of the artwork. The record stays,
and `tools/failed-steps.mjs` reports every failure with its reason.

There is **NO quality gate**. Every child that passes the package checks is kept,
whatever the frame looks like. A step is refused only for a real technical fault:
a package that does not load, or a capture that fails or passes its time limit.

Observed on 2026-09-19, with `deepseek/deepseek-v4.1-flash`:

- The model sometimes writes code that throws when the artwork loads, for example
  `dirX is not defined`. The capture reports `capture_load_failed`, the step gets
  one repair session, and the reason stays on the card.
- A server restart in the middle of a step can leave an already PUBLISHED
  snapshot. Its paid work is durable: the restart keeps it, and a resume revives
  it and continues, so the step is not paid for twice. A version that was not
  published is failed with `interrupted_by_restart`.
- A promote fault never ends a run: the step is recorded as failed and the next
  step starts from the last good version.
- A capture that hangs can never hold a run. The capture has a wall-clock
  deadline, and the controller has a second ceiling around every capture. A
  timeout fails the step with `capture_timeout` and spends no repair session,
  because it is an infrastructure fault, not a fault of the code. One capture
  hung for three hours before this ceiling existed.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PHYGEN_ALLOW_SPEND` | unset | Model calls are refused until this is `1`. |
| `PHYGEN_DRIVER` | `auto` | `pi`, `fake`, or `auto`. |
| `PHYGEN_PI_ENTRY` | unset | The JavaScript entry of the Pi CLI. **Set this on Windows**: Node cannot start the `pi.cmd` shim (it fails with `spawn EINVAL`), so point it at the CLI bundle, for example `%LOCALAPPDATA%\pi-node\current\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`. |
| `PHYGEN_MODEL` | `deepseek/deepseek-v4.1-flash` | The model of the run. The step session must accept images. |
| `PHYGEN_AUTHOR_MODEL` | as above | The author model. |
| `PHYGEN_AUTHOR_THINKING` | `high` | Author effort. `minimal` is much faster and much shallower. |
| `PHYGEN_STEP_SCHEDULE` | `2500` | The captured steps, comma separated, increasing. |
| `PHYGEN_MAX_RUN_USD` | `0` | A cost limit. `0` enforces none. |
| `PHYGEN_COST_SAFETY_FACTOR` | `1.8` | The reserve is this multiple of the estimate. |
| `PHYGEN_REQUIRE_ISOLATION` | `0` | `1` refuses source candidates without a container. |
| `PHYGEN_CAPTURE` | `auto` | `local`, `docker`, or `auto`. |
| `PHYGEN_CAPTURE_TIMEOUT_MS` | `600000` | The limit for ONE frame, so a heavy simulation can finish. The controller adds a 20% margin on top. |
| `PHYGEN_SESSION_TIMEOUT_MS` | `1800000` | Limit for one author session. |
| `PHYGEN_CLEANUP_WORKSPACES` | `1` | Remove candidate workspaces when a run ends. |
| `PHYGEN_DATA` | `data-evolve` | The records directory. |

## The interface

The interface is read-only. It has one button.

- A vertical column of large cards, newest at the top. Each card holds the step
  number and title, a 1024 x 1024 square, a quiet line with the changed files,
  the tokens, and the cost.
- While a step works, its card shows a black-and-white loading art: a field of
  4400 4 px pixels over the whole square, and NOTHING else. Nothing is written
  over the field and no line travels around it; the stage of the step shows on
  the card and in the shell.
- The screen is a grid of **256 x 256 pixels**: one pixel is 4 CSS px across a
  1024 px card. A particle IS one pixel. It moves in WHOLE pixels only — it is
  never drawn between two pixels — along one axis, and it may only turn a quarter
  turn when it arrives on a new pixel. It never reverses, never moves at an
  angle, never grows, and never leaves a trail. It wraps at the screen edge.
- Speeds run from 1.5 to 3.5 pixels per second, and a pixel turns about once
  every 1.3 s (measured: 46.8 turns per minute), so the bending is visible in a
  few seconds of watching. The rule is in `web/src/texture.ts`, and
  `web/test/texture.test.mjs` tests the 256 grid, whole-pixel movement, the
  quarter turn, the ban on reversal, the wrap, the constant size, that turns
  HAPPEN, and that the route does not depend on the frame rate.
- The field is drawn on a canvas, not as SVG children. Measured: 900 SVG marks
  that each carry their own animation run at 25 fps, because an SVG child
  animates on the main thread; the canvas draws the whole moving field at no
  measurable cost (54.1 fps against a 53.5 fps baseline).
- A person who prefers less motion sees the pixels drift at a quarter of the
  speed, and the bar travel slower.
- Exactly one live player runs at a time. While the large live view is open, the
  card behind it shows its still frame and its chip reads `paused`, so the two
  players never halve each other's frame rate.
- Exactly one card plays live, and which one is decided by the SCROLL. The card
  that holds the top of the view plays; scrolling down stops that artwork and
  starts the next. A card that is still being made cannot play, so the newest
  finished artwork plays instead — that is what a page shows when it loads during
  a run. Every other card shows its still frame. A card with no frame yet shows
  its stage.
- A large live view opens from the card.
- A resizable shell holds the agent log, newest at the bottom. It follows the
  work while a step runs. The reasoning rows are dim, the agent text is normal,
  and a tool row names the tool, the short path, and the line counts. The shell
  starts at half the height, and the split is kept in `localStorage`.
- The header holds the model list, the step count (1 to 100, default 1), and the
  Evolve button.
- A slim status line shows the state, `step X of Y`, the spend, the provider, and
  whether the stream is live.

The playing rules live in `web/src/chain.ts`, and `web/test/chain.test.mjs` tests
them: `visibleCardId` picks the card at the reading line, `autoplayCardId` picks
the one that plays there, and `playingVersionId` names the newest finished
artwork for the initial state.

## Layout

- `runtime/` — the shared artwork contract, the schema validator, the strict
  configuration loader, the manifest rules, and the Node package checks.
- `threejs/` — the `physarum` artwork package.
- `server/` — the controller. `src/controller/run.mjs` owns the step loop, the
  budgets, and the chain head. `src/providers/` holds the Pi driver and the test
  double. `src/capture/` holds the browser capture and the container worker.
  `src/api/` holds the controller API and the separate artwork origin.
- `web/` — the React and TypeScript interface.
- `docs/` — the API contract, the measurements, the flow diagram, and images.
- `data-evolve/`, `snapshots/` — records, captures, and immutable snapshots. Not
  source.

## Phase status

| Phase | State |
| --- | --- |
| 1. Feasibility | Capture is measured on this machine (docs/MEASUREMENTS.md). |
| 2. Root package | Complete. |
| 3. One step | Complete with the test double and with the real model. |
| 4. Interface | Complete: the forward chain, the still frames, the single live card, the resizable shell, the live modal, and the status line. |
| 5. Repeated runs | Complete: multi-step runs, stop, resume after a pause, and restart recovery. |
| 6. Deployment | Not started. It needs separate approval. |

## Next task

Watch the chain. The frames are the evidence. When a step is weak, the chain
still holds it: a person can see the change and judge it, and the next step
starts from that child.

Possible later work, none of it requested yet:

- A pop tool, to remove a weak child and its descendants.
- A second artwork, and an artwork selector.
- A per-step diff view of the source.

## Open risks

- A server restart PAUSES every in-flight run on purpose, because a paid request
  may have been accepted. Resume it with `POST /api/runs/:runId/resume`.
- The Pi child process needs its standard input closed. An open pipe makes it wait
  forever. `server/src/providers/pi.mjs` sets this.
- Source-code candidates run in the sandboxed artwork page, not in a container.
  Set `PHYGEN_REQUIRE_ISOLATION=1` on a server, and build the capture image
  (`server/docker/Dockerfile`) for the stronger boundary. The image is untested.
- The API has no authentication and no CSRF control. Keep it on the loopback
  address until Phase 6.
- There is NO quality gate. Every child that passes the package checks is kept,
  whatever it looks like. The chain is the record, and a person judges the
  frames. A step is refused only for a real technical fault: a package that does
  not load, or a capture that fails or passes its time limit.
