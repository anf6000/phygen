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

A configured limit that refuses a request must stop the run. It must not consume
an evolution and it must not look like a candidate fault. The run records the
exact reason, for example `budget_exceeded`, and names the limit.

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
cd server && npm test       # 43 controller and measurement tests
cd threejs && npm test      # 57 artwork tests
cd web && npm test          # 12 generation-ring layout tests
cd threejs && npm run validate
cd server && npm run capture-check -- --version <id>   # capture measurement
cd server && node tools/snapshot-report.mjs            # snapshot integrity report
cd server && node tools/backup.mjs --out <dir>         # consistent backup
node tools/live-check.mjs   # the live artwork on both routes
node tools/ui-check.mjs     # the selection survives a reload; writes a tree image
node tools/pages-shot.mjs   # one image of every page
```

## The camera never zooms on its own

The complaint "the nodes disappear while rendering" had one cause: **following
the active node framed its family and zoomed in**, so that family filled the
screen and the rest of the tree was off-frame. Following now:

- **pans only, and never changes the zoom**;
- moves only when the working version has left the viewport, with a margin;
- stops panning once a person pans or zooms themselves, until Fit all or Focus
  selection is pressed.

`?doc=1` and the documentation camera are **removed**. The recorder no longer
appends it, and the interface has no mode that moves the camera. The recorder
also verifies that the canvas actually rendered before it writes a single frame,
and refuses with a reason instead of recording a blank canvas. A recording now
shows the whole tree.

Measured: with follow ticked, the zoom stayed at 0.16 and 46 of 49 cards stayed
in view across 30 seconds, and the recorder's own frames show the whole tree.

A level also advances when the judge answer cannot be used at all: the earliest
variant takes the lineage and the record says the comparison failed, so a
malformed judgement cannot freeze the line.



`appearance` compares two versions by how different they LOOK, using a vision
model. It is listed as available whenever the provider can see frames, and it is
refused with a reason when the provider is the deterministic test double.

- The versions are anonymous: only the labels A and B appear in the prompt, never
  a title, an id, or which came first. One frame per version is sent: the middle
  frame of its sequence.
- The score is a DISTANCE in [0, 1], the same direction as every other measure.
  A non-zero score must name what differs, or the answer is a failure.
- Bounded by PAIRS, not by money, as chosen: `PHYGEN_APPEARANCE_MAX_PAIRS` (60).
  The per-call ceiling is `PHYGEN_COST_APPEARANCE_USD` (0.05) and the model is
  `PHYGEN_APPEARANCE_MODEL`, which defaults to the judge model.
- Every pair records its score, the differences it named, the frames behind it,
  the model, and its real cost. The cost also goes to the `usage` ledger with no
  run and no version, because it belongs to a measurement, not to an artwork.
- A record is reused only when both versions' source and configuration hashes AND
  the frame identities are unchanged, so a recapture measures the pair again.
- The panel shows the model and the CEILING before the run, and the real cost
  afterwards. The ceiling is not a forecast: 60 pairs at the 0.05 bound is $3.00,
  and the real cost of a two-image call is far lower.

Measured real cost of one pair is not yet known: run a small budget (for example
four pairs, about two cents) to learn it, then set the pair budget from that.



## Two trees, and which one the server uses

The records live where `PHYGEN_DATA` points. Two trees exist now:

| Directory | What it holds |
| --- | --- |
| `data/` | The manual tree: 73 versions, 16 runs, the record of the hand-picked era. Its last run was left `running` and the next start PAUSES it as `paused_after_restart`, so it can be resumed. |
| `data-simple/` | The fresh tree: ONE version, `Root` at generation 0, the mother. Started from it with `PHYGEN_DATA=data-simple`. |

Both trees share the published snapshots in `snapshots/`, which are
content-addressed: the mother of the fresh tree names the same directory as the
mother of the manual tree (`5883e4a0a59f…`), so nothing was re-rendered or
duplicated.

Start against the tree you want:

```powershell
$env:PHYGEN_DATA = 'S:\PROJECTS\phygen\data-simple'   # the fresh tree
$env:PHYGEN_DATA = 'S:\PROJECTS\phygen\data'          # the manual tree
```

Only one server can hold the port at a time, so switching means stopping and
starting. A second artwork in the SAME database is not possible yet: the import
route is idempotent per package path, and the interface always shows the oldest
artwork. That is what plan slice 6 fixes with a pop tool and an artwork selector.



## Autonomous heredity

A run is **autonomous by default**. It starts from the seed version, then reads
its **archive** at every level and picks its own parent, rotating three roles:
`exploit` the best quality, `explore` the furthest from it, and `repair` the
weakest member still worth keeping. Every pick and every promotion records why.

- The archive holds at most `PHYGEN_ARCHIVE_SIZE` versions (8) that clear
  `PHYGEN_QUALITY_FLOOR` (0.4) and are at least `PHYGEN_NOVELTY_FLOOR` (0.35)
  apart. Quality is the win and loss tally over every comparison of the artwork,
  smoothed so one lucky win cannot outrank a proven record.
- A candidate is promoted on quality by the margin, **or** on novelty above the
  floor when its quality is not worse than the parent by more than
  `PHYGEN_QUALITY_TOLERANCE` (0.1). The decision records the branch and the
  numbers. A disagreement between the two comparison orders is not evidence, and
  the parent stays.
- A run with no direction **writes one** from the records: the judge's recorded
  weaknesses, the configuration fields the archive has moved least, or a stall.
  The recorded direction names its own source.
- A **pinned** run (`pinned: true`) follows the promoted lineage and must state a
  direction. That is the predictable mode.

`GET /api/artworks/:id/archive` reports the members, every refusal with its
reason, and the mean novelty. Measured on the manual tree: **65 versions, 5
members, 46 refused for quality, 12 near-duplicates, mean novelty 0.62** — that
tree is mostly near-copies, which is why the novelty floor and the appearance
measure matter.

### The appearance measure

Built. It shows a vision model one frame of each version under the blind labels A
and B and asks how different they look. The score is a distance in [0, 1], the
same direction as the other measures. A non-zero score must name what differs.

- Bounded by PAIRS, as chosen: `PHYGEN_APPEARANCE_MAX_PAIRS` (60), with a per-call
  ceiling `PHYGEN_COST_APPEARANCE_USD` (0.05) and `PHYGEN_APPEARANCE_MODEL`, which
  defaults to the judge model.
- Each pair records its score, the differences it named, the frames behind it, the
  model, and its real cost. The cost also goes to the `usage` ledger with no run
  and no version: it belongs to a measurement, not to an artwork.
- A record is reused only when both versions' source and configuration hashes AND
  the frame identities are unchanged, so a recapture measures the pair again.
- With the test double the measure is listed as unavailable and refused with the
  reason, so no invented numbers are ever produced.
- The panel shows the model and the CEILING before the run and the real cost
  after. The ceiling is not a forecast.

**The real cost of one pair is still unknown.** Run a small budget, four pairs for
example, to learn it and then set the pair budget from that number.

Not built yet: the **pop tool** (`tools/new-pop.mjs`), the **archive panel**, the
**pin switch** in the header, and the plan's fuller policy of three parents per
level, each compared with its own parent. The plan is at
`phygen-autonomous-heredity-impl.md` in the plans directory.

## Generation rings and measured relationships


The version canvas draws **generation rings**. Every node's children are placed
around that node, and the arrangement repeats at every level, so the tree grows
as a recursive circular structure.

The root is the centre and its children surround it. Every other node spreads
its children over a fan centred on the direction **away from its parent**, so no
child is ever placed behind its own parent. A brood whose children are all
leaves is packed as a **block** at card pitch instead of a ring, which is much
tighter: none of those children needs room to grow outward.

The spacing is solved on the real card rectangles, which is the tightest spacing
that holds the cards, and a repair pass measures every pair again and spreads the
drawing only when the geometry demands it. The canvas reports any pair it could
not separate.

The canvas calculates ring positions before the "hide failed" filter is applied.
A filter changes what is drawn. It never moves a card. The original root stays
visible when a filter would remove it.

Ring position is **ancestry**. It is not similarity. A second, separate layer
holds **measured relationships**: one record per pair of versions and per
measure. Ancestry is drawn as straight black lines. A measured relationship is
drawn as a purple cubic bow, at every zoom including the widest, and keeps its
width on screen so it stays readable when the whole artwork is in view. The
measured layer can be hidden.

Two deterministic measures are available now. They call no model and spend
nothing:

- **Configuration distance**: the share of configuration fields that differ.
- **Source similarity**: one minus the share of shared token sequences.

An appearance measure, which would read the captured frames with a model, is
listed but not enabled. The interface states that it is unavailable and states
that an individual-type comparison does not exist. It never substitutes a
silent approximation.

A measurement run is bounded by `PHYGEN_ANALYSIS_MAX_PAIRS` (default 400). It
records its own progress, it can be cancelled, and it is never resumed
automatically after a restart. The interface shows the record revision and
whether the measurement is out of date.


## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PHYGEN_ALLOW_SPEND` | unset | Model calls are refused until this is `1`. |
| `PHYGEN_DRIVER` | `auto` | `pi`, `fake`, or `auto`. |
| `PHYGEN_PI_ENTRY` | unset | The JavaScript entry of the Pi CLI. **Set this on Windows**: Node cannot start the `pi.cmd` shim (it fails with `spawn EINVAL`), so point it at the CLI bundle instead, for example `%LOCALAPPDATA%\pi-node\current\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`. |
| `PHYGEN_MODEL` | `moonshotai/kimi-k3` | The judge model. |
| `PHYGEN_AUTHOR_MODEL` | as above | The author model. |
| `PHYGEN_VARIANTS` | `3` | Default children per evolution. |
| `PHYGEN_MAX_RUN_USD` | `0` | A cost limit. `0` enforces none. |
| `PHYGEN_COST_SAFETY_FACTOR` | `1.8` | The reserve is this multiple of the estimate. |
| `PHYGEN_REQUIRE_ISOLATION` | `0` | `1` refuses source candidates without a container. |
| `PHYGEN_CAPTURE` | `auto` | `local`, `docker`, or `auto`. |

### The test double

`PHYGEN_DRIVER=fake` runs a deterministic stub. It ignores the direction, its
code changes are canned, and every comparison it produces carries `stub: true`
with the note "Deterministic test double. Never use this verdict as aesthetic
evidence". The interface shows a red banner while it is in use, and every card it
produced carries a **test double** chip.

Remove such work, and anything built on top of it, with:

```bash
cd server && node tools/prune-failed.mjs --stub          # show the plan
cd server && node tools/prune-failed.mjs --stub --apply  # do it
```

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
