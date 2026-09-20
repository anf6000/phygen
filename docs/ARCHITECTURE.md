# Phygen architecture

This document holds the durable structure and the rules that are easy to get
wrong. It does not repeat the work rules in `AGENTS.md`.

## Layers

```
runtime/            the artwork package contract, shared by every side
threejs/            one artwork package (the physarum simulation)
server/             the controller: records, providers, capture, the API
  src/artwork/      package review, workspace copy, snapshot publication
  src/controller/   one run: the step loop, prompts, budgets, the agent feed
  src/providers/    the Pi session driver and the deterministic test double
  src/capture/      the browser capture and the container worker
web/                the interface: the chain, the cards, the shell, the live view
  src/chain.ts      the pure chain order and the playing rule
```

## The forward chain

A run is a **linear chain**. Each step makes exactly one child of the newest
version with status `promoted`, which is the **chain head**.

- There is no judge, no comparison, no variant, and no archive. The child is
  always kept, and a person judges quality by looking at the frames.
- The chain head is read again before every step, so a failed step never becomes
  a parent.
- A step that fails a technical check, after one bounded repair session, marks
  its version `failed` and leaves the chain head where it was.
- A failed version is terminal. The one path back is the operator repair:
  `RunController.repairVersion` starts from the failed candidate's OWN published
  snapshot, runs one repair session with the failure, then validates, publishes,
  captures, and promotes it. It is refused while a run is active.
- The imported root has no capture until `RunController.captureFrame` runs. The
  import route starts that in the background, so the root card shows a real frame.
- An interrupted step (a pause) is recorded but does not consume a step. A resume
  reuses the child the run already published, because a published snapshot is
  immutable and must not be paid for twice.

The chain is a straight line in the records: every child has one `parent_id` and
one `generation`, and the records are ordered by generation and creation time.

## One step

1. Read the chain head.
2. Create the child row, and copy the parent snapshot into
   `data-evolve/workspaces/<runId>/<versionId>/`.
3. Run one author session with the fixed instruction. The session receives the
   manifest rules, the parent configuration, the history of this run, and the
   last three frames of the chain, newest first.
4. Review the edits against the manifest, check the package, and validate the
   configuration. A technical failure gets one bounded repair session.
5. Publish the snapshot (immutable, content addressed).
6. Capture one late square frame: 1024 x 1024, seed 1337, step 2500.
7. Promote the child.

The prompt tells the session to keep the seeded stream reproducible, to keep the
adapter contract, to change at least one file under `src/`, and to keep the
network visible.

### There is no quality gate

The child is always kept. There is no judge, no comparison, and no measure of the
frame, because there is no selection to make: a person judges the work by looking
at the chain. A step is refused only for a real technical fault — a package that
does not load, or a capture that fails or passes its time limit. A quiet, dark, or
bold frame is a step, and it stays.

## Runs and recovery

- A configured limit that refuses admission stops the run. It does not consume a
  step and it is not recorded as a candidate fault.
- A pause stops new steps. The interrupted step is recorded and does not consume
  a step. A resume reuses the child the run already published.
- A stop is checked before every provider reservation, before every retry delay,
  and before every process start. A stop can never start another paid session.
- After a restart, an in-flight run pauses with the reason `paused_after_restart`,
  and its running jobs are marked failed with `interrupted_by_restart`. A paid
  request may have been accepted, so a person decides what to do next.

## Snapshots

A published snapshot is immutable. Its directory name, its marker, the returned
hash, and the version record all name the same **package-relative** content hash,
which is the hash `checkPackage` computes.

Snapshots published before this rule used the path prefix `files/` in the marker
hash. That older evidence is never rewritten. `canonical-hashes.json`, beside the
snapshot directories, records the mapping, and `tools/snapshot-report.mjs`
verifies every snapshot in read-only mode.

Publication writes to a unique working directory and renames it into place, so
two publications of one hash cannot delete each other's files. An existing
snapshot is reused only after its file hashes are verified.

## The agent feed

The source is the Pi JSON event stream. `tool_execution_start` carries the tool
name and its arguments, so an `edit` gives the changed text and a `write` gives
the content; `tool_execution_end` says whether it failed; `message_update` gives
the assistant text and the reasoning as they arrive; `turn_end` gives the tokens
and the cost.

`src/controller/agent-events.mjs` maps those events to `agent` rows. A reasoning
block becomes a `reason` row, the answer text becomes a `text` row, and a tool
call becomes a `tool` row with the short path and the line counts. Every row is
capped at 4000 characters, and the text and reasoning rows are throttled to one
row per half second, so one row cannot flood the stream.

The controller stores every row in the `events` table. `GET
/api/versions/:versionId/agent` returns the stored feed of one version, so a
finished version still shows how it was made. The workspace reader adds the real
line counts of the files the session touched.

## The interface

- One vertical column of cards, newest at the top. A card holds the step number
  and title, a 1024 x 1024 square, the changed files, the tokens, and the cost.
- Exactly one card plays live: the newest promoted version. `playingVersionId` in
  `web/src/chain.ts` is the single rule, and it is tested.
- Every other card shows its still frame, its stage, or its failure reason.
- The shell is a read-only log, newest at the bottom. It follows the work while a
  step runs, and it shows the stored rows of a selected card.
- The chain area and the shell are split by a drag handle. The split is kept in
  `localStorage`.

The playing rule is a pure function on the version records, so a card never
decides for itself whether it plays.

## Event stream

The client subscribes before the replay starts, so an event cannot slip between
the last replayed page and the subscription. The complete missed range is paged
up to the high-water sequence that was current at subscription time. A client
that cannot keep up is closed with a comment, so it reconnects from its last
sequence and receives exactly what it missed. Events are never trimmed silently.
