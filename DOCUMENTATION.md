# Phygen — how the system works

Phygen evolves a generative artwork. It spawns variants of a version, renders
them, lets a judge compare the frames, and promotes a winner. Every step is
recorded, so the history of the artwork is evidence rather than memory.

## The pieces

| Path | What it holds |
| --- | --- |
| `runtime/` | The artwork package contract. It is shared by the server and the artwork. |
| `threejs/` | One artwork package: the physarum simulation that the runs evolve. |
| `server/` | The controller. It owns the records, the provider sessions, the capture, and the judging. |
| `web/` | The interface: the version canvas, the detail panel, and the measurement panel. |
| `data/` | The SQLite database, the captured frames, and the temporary workspaces. |
| `snapshots/` | The immutable published packages, one directory per content hash. |

## The artwork package

A package is a directory with a `manifest.json`, a baseline `config.json`, and a
schema for that configuration. The manifest declares the contract version, the
entry module, the paths a session may edit, the paths it must not touch, the
pinned dependencies, and the resource limits.

The entry module implements a fixed adapter: `initialize`, `reset`, `step`,
`render`, `resize`, `getState`, `setDisplayPalette`, and `dispose`. The runtime
rejects a package that misses a method, that declares a different contract
version, or that breaks its own configuration schema.

A session may edit `src/` and `config.json`. It may not edit the manifest, the
entry, `index.html`, `package.json`, the schema, or the package tests. The
server rejects any edit outside the allowed paths before it runs anything.

## The life of one run

1. **Admission.** `POST /api/runs` validates the request, checks that the
   comparison can hold every variant plus the parent, and asks the budget
   whether the highest possible cost fits the limits. A refusal happens before
   any record exists, so a refused run can never sit in the queue.
2. **Plan the level.** The run plans one evolution and gives each variant a role:
   `refinement`, `structure`, or `experiment`. The number of variants is your
   setting.
3. **Author.** Each variant gets its own session in its own copy of the package.
   The session receives the direction, the parent configuration, and the parent
   code. Several sessions run at once. Every session writes its files inside its
   own workspace.
4. **Validate.** The server checks the manifest, the configuration against the
   schema, the edited paths, the package size, and the dependency pins.
5. **Publish.** The server copies the accepted workspace into
   `snapshots/<package>/<hash>/`. The hash covers the package-relative paths, so
   the directory name, the marker file, and the version record agree. A published
   snapshot is immutable.
6. **Capture.** The server renders the candidate and the parent at the same
   seeds and steps, from the published snapshot, in the sandboxed artwork page on
   its own origin. The defaults are 768 by 768 at device pixel ratio 1, two
   seeds, and three stages at steps 600, 1800 and 3600.
7. **Judge.** The judge receives the frames side by side under labels, without
   the names of the versions, and states which one it prefers. The server runs
   the comparison twice, in both orders, and accepts a winner only when the two
   agree. When they disagree, one tie-break runs.
8. **Decide.** A candidate takes the lineage only when it beats the parent by the
   promotion margin. Otherwise the parent stays, and the run records why.
9. **Next level.** The winner becomes the parent of the next evolution. When the
   requested levels are complete, the run is completed.

## The records

| Table | It holds |
| --- | --- |
| `artworks` | One row per artwork, with its canonical root version. |
| `versions` | Every version: parent, generation, role, status, configuration, changes, snapshot path, source hash. |
| `runs` | Every run: direction, protocol, estimate, cost bound, state, stop reason. |
| `rounds` | One row per level: the parent, the candidates, the winner, and the reason. |
| `jobs` | One row per unit of work: author, validate, publish, capture, judge. |
| `captures` | Every rendered frame, with its stage, seed, step, size, and hashes. |
| `comparisons` | Every judge call, with the label order, the verdict, and the confidence. |
| `evaluations` | The outcome recorded against each candidate. |
| `usage` | The real cost and token count of each call, and whether the provider or the bound supplied it. |
| `events` | The ordered event stream that the interface replays. |
| `analysis_runs`, `pair_measurements` | The measurement layer (below). |

## Control and recovery

- **Pause** stops admission of new work after the current bounded task. The
  interrupted level is recorded and does not consume an evolution. **Resume**
  continues the same level, reuses the candidates the run already published, and
  reuses the comparisons it already completed.
- **Stop** ends the run. Work already published stays. A stop is checked before
  every reservation, every retry delay, and every provider start, so a stopped
  run can never start another paid session.
- **A configured limit** stops the run and names the limit. It does not consume
  an evolution, and it does not look like a candidate fault.
- **A restart** pauses unfinished runs for review, and marks unfinished
  measurements failed. Nothing is resumed automatically.
- **The event stream** subscribes before it replays, pages the complete missed
  range, and closes a client that falls too far behind, so no event is lost and
  no gap is hidden.

## The measurement layer

A measurement is a record about **a pair of versions**. It never changes a parent
link and never places a card.

Two measures are available. Both spend nothing and repeat exactly:

- **Configuration distance**: the share of configuration fields that differ.
- **Source similarity**: one minus the share of shared token sequences.

A third measure, which would read the frames with a model, is listed as not
enabled. The interface states that, and states that an individual comparison
does not exist. A measurement run has a fixed pair budget, records its progress,
and can be cancelled. The plan is deterministic: it always measures a version
against its parent, against its round, against the adjacent generation, and
against its own role, then fills the remaining budget with a seeded sample. A
record is reused only when both versions still hold the same source and
configuration hashes. The interface shows the record revision, and says when the
artwork has changed and the measurement is out of date.

## The interface

- The **header** holds the direction, the levels, the variants, the two models,
  the cost estimate, and the run buttons. The estimate uses catalog prices; the
  provider usage is authoritative.
- The **canvas** draws the versions as generation rings. Each parent's children
  surround it. A brood whose children are all leaves is packed as a block, which
  is much tighter. The canonical root is the centre. Positions are calculated
  before any filter is applied, so hiding failed versions never moves a card.
- **Ancestry** is drawn as straight black lines: a spoke says "this card hangs
  from that one".
- A **measured relationship** is drawn as a purple cubic bow, at every zoom, and
  keeps its width on screen. The layer has its own toggle.
- The **detail panel** shows one version: its frames, its explanation, its
  configuration, and its changes. The **measurement panel** shows the measures,
  the pair table, and the evidence of a selected pair.
- The **status strip** shows the provider, the capture backend, the stream
  position, the run state, the spend, and the calls.

The canvas never zooms below the level at which a card stays a usable target, and
drawn lines never take a pointer event, so a click always reaches a card.

## Cost

Before each provider call the server reserves the highest cost of that call.
After the call it commits the real cost, or the bound when the provider reports
none. The two models have separate bounds. The reserve, the commit, the cost
source, and the token count are all recorded per call.

The estimate before a run uses catalog prices and an expected token count. The
record keeps the real cost. A cost limit is enforced only when you set one:
`PHYGEN_MAX_RUN_USD` limits money, and the call, token, round and time limits
work the same way.

## The test double

`PHYGEN_DRIVER=fake` runs a deterministic stub instead of a model. It ignores the
direction, its code changes are canned, and every comparison it makes is marked
`stub` with the note "Never use this verdict as aesthetic evidence". The header
shows a red banner while it is in use, and every card it produced carries a
**test double** chip. Work made by the stub is not work.

## Operating it

Install once, in `server/` and `web/`:

```bash
npm install
```

Run the system, from `server/`:

```bash
npm start          # API and interface on 8787, artwork origin on 8788
```

Open <http://127.0.0.1:8787/>.

Checks:

```bash
cd server && npm test        # controller, records, measurement, prune
cd threejs && npm test       # the artwork
cd threejs && npm run validate
cd web && npm test           # the ring layout
```

Tools, from `server/`:

```bash
node tools/backup.mjs --out <dir>        # one consistent copy of the records and their files
node tools/snapshot-report.mjs           # read-only integrity report of every snapshot
node tools/prune-failed.mjs              # plan the removal of failed versions
node tools/prune-failed.mjs --stub       # plan the removal of test-double work
npm run capture-check -- --version <id>  # measure one capture
```

## Where the durable detail lives

- `AGENTS.md` — the work rules for an agent in this repository.
- `TASKS.md` — the current state, the commands, and every setting.
- `docs/ARCHITECTURE.md` — the layout, snapshot, recovery, and event rules that
  are easy to get wrong, and the approaches that were measured and rejected.
- This file — how the system works, for a reader.
