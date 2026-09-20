# Phygen — how the system works

Phygen evolves a generative artwork. One run makes a forward chain of versions:
each step authors one child of the newest good version, renders it, and keeps it.
Every step is recorded, so the history of the artwork is evidence rather than
memory. A person judges the frames; there is no judge model.

The rules that are easy to get wrong are in `docs/ARCHITECTURE.md`. The wire
contract is in `docs/API.md`. This file is the reader's guide.

## The pieces

| Path | What it holds |
| --- | --- |
| `runtime/` | The artwork package contract. It is shared by the server and the artwork. |
| `threejs/` | One artwork package: the physarum simulation that the runs evolve. |
| `server/` | The controller. It owns the records, the provider sessions, the capture, and the API. |
| `web/` | The interface: the chain, the cards, the agent shell, and the live view. |
| `data-evolve/` | The SQLite database, the captured frames, and the temporary workspaces. |
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
entry, `index.html`, `package.json`, the schema, or the package tests. The server
rejects any edit outside the allowed paths before it runs anything.

## The life of one step

1. **Admission.** `POST /api/runs` validates the request and asks the budget
   whether the highest possible cost fits the limits. A refusal happens before
   any record exists, so a refused run can never sit in the queue.
2. **Chain head.** The run reads the newest version with status `promoted`. On
   the first step that is the imported root, the mother.
3. **Author.** The child gets its own copy of the parent package in
   `data-evolve/workspaces/<runId>/<versionId>/`. One session edits it. The
   session receives the fixed instruction, the manifest rules, the parent
   configuration, the history of this run, and the last three frames of the
   chain, newest first.
4. **Validate.** The server checks the manifest edit surface, the configuration
   against the schema, the package size, and the dependency pins. A technical
   failure gets one bounded repair session.
5. **Publish.** The server copies the accepted workspace into
   `snapshots/<package>/<hash>/`. The hash covers the package-relative paths, so
   the directory name, the marker file, and the version record agree. A published
   snapshot is immutable.
6. **Capture.** The server renders the child from the published snapshot, in the
   sandboxed artwork page on its own origin: one 1024 x 1024 square, seed 1337,
   step 2500.
7. **Promote.** The child is promoted and becomes the chain head. The next step
   starts from it.

A step that fails a technical check, or whose frame is effectively black, is
recorded as `failed`. It does not become a parent, and the next step starts from
the last good version.

## The records

| Table | It holds |
| --- | --- |
| `artworks` | One row per artwork, with its canonical root version. |
| `versions` | Every version: parent, generation, step, status, configuration, changes, snapshot path, source hash, explanation, failure reason. |
| `runs` | Every run: protocol, estimate, cost bound, state, stop reason, step count. |
| `rounds` | One row per step: the parent, the one candidate, whether it was promoted, and the note. |
| `jobs` | One row per unit of work: author, publish, capture. |
| `captures` | Every rendered frame, with its stage, seed, step, size, and hashes. |
| `usage` | The real cost and token count of each call, and whether the provider or the bound supplied it. |
| `events` | The ordered event stream that the interface replays, including the agent feed rows. |

## Control and recovery

- **Pause** stops new steps after the current bounded step. The interrupted step
  is recorded and does not consume a step. **Resume** continues it, and reuses
  the child the run already published.
- **Stop** ends the run. Work already published stays. A stop is checked before
  every reservation, every retry delay, and every provider start, so a stopped
  run can never start another paid session.
- **A configured limit** stops the run and names the limit. It does not consume a
  step, and it does not look like a candidate fault.
- **A restart** pauses unfinished runs for review. Nothing is resumed
  automatically.
- **The event stream** subscribes before it replays, pages the complete missed
  range, and closes a client that falls too far behind, so no event is lost and
  no gap is hidden.

## The interface

- The **header** holds the model list, the step count, and one button: Evolve.
- The **chain** is one vertical column of large cards, newest at the top. A card
  holds the step number and title, a 1024 x 1024 square, the changed files, the
  tokens, and the cost.
- Exactly one card plays live: the newest promoted version. Every other card
  shows its still frame or its stage. A failed step is not shown at all: the
  chain holds the work that was kept.
- The **shell** is a read-only log of the agent, newest at the bottom. It follows
  the work while a step runs, and it shows the stored log of a selected card. A
  tool row names the tool, the short path, and the line counts. The reasoning
  rows are dim.
- The chain and the shell are separated by a drag handle. The split starts at
  half the height and is kept in `localStorage`.
- The **status line** shows the state, `step X of Y`, the spend, the provider, and
  whether the stream is live.

## Cost

Before each provider call the server reserves the highest cost of that call.
After the call it commits the real cost, or the bound when the provider reports
none. The reserve, the commit, the cost source, and the token count are all
recorded per call.

The estimate before a run uses catalog prices and an expected token count. The
record keeps the real cost. A cost limit is enforced only when you set one:
`PHYGEN_MAX_RUN_USD` limits money, and the call, token, step, and time limits
work the same way.

## The test double

`PHYGEN_DRIVER=fake` runs a deterministic stub instead of a model. Its code
changes are canned, and every card it produced carries a **test double** chip.
Work made by the stub is not work.

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
cd server && npm test        # the step loop, budgets, storage, events
cd threejs && npm test       # the artwork
cd threejs && npm run validate
cd web && npm test           # the chain order and the playing rule
cd web && npm run build
```

Tools, from `server/`:

```bash
node tools/backup.mjs --out <dir>        # one consistent copy of the records and their files
node tools/snapshot-report.mjs           # read-only integrity report of every snapshot
node tools/live-check.mjs --version <id> # the live artwork on both routes
```

## Where the durable detail lives

- `AGENTS.md` — the work rules for an agent in this repository.
- `TASKS.md` — the current state, the commands, and every setting.
- `docs/ARCHITECTURE.md` — the structure and the rules that are easy to get wrong.
- `docs/API.md` — the wire contract.
- This file — how the system works, for a reader.
