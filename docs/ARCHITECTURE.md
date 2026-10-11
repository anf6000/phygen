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
  src/vision/       the free image metrics, the hard tests, the rubric, the judge
  src/gate/         the archive, the self-written direction, the measure step
web/                the interface: the chain, the cards, the shell, the live view
  src/chain.ts      the pure chain order and the playing rule
```

## The forward chain

A run is a **linear chain**. Each step makes exactly one child of the newest
version with status `promoted`, which is the **chain head**.

- There is no comparison between two candidates and no variant fan-out. One step
  makes one child. The perceptual gate below decides whether that child is kept
  or parked, and a person still judges quality by looking at the frames.
- The chain head is read again before every step, so a failed or parked step
  never becomes a parent.
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
6. Capture TWO ordered frames: an early frame at half the late step, then the
   late square frame: 1024 x 1024, seed 1337, step 1000. The late frame is the
   card identity; the early frame is the development probe.
7. Run the perceptual gate: measure the frames, run the hard tests, compute the
   coherence and the novelty, judge a survivor, then decide keep or park.
8. Promote the child, or park it (see below).

The prompt tells the session to keep the seeded stream reproducible, to keep the
adapter contract, to change at least one file under `src/`, and to keep the
network visible.

## The perceptual gate

The gate is a self-judgment. It measures the captured PNG in Node, with no
model, and reaches a verdict from numbers. It never reads a source line, and the
author never sees its own frame, so the judgment is blind.

- `src/vision/png.mjs` decodes the PNG with no dependency. A format it cannot
  decode is a RECORDED skip, never a zero.
- `src/vision/metrics.mjs` returns the free features: colorfulness, saturation
  clipping, tonal entropy, edge density and balance, occupancy, the dominant
  ridge share, and the hue spread.
- `src/vision/tests.mjs` holds the HARD tests: `saturation_clipping`,
  `uniform_noise`, `empty_or_cord`, `rainbow`, and `strobing`. A test that could
  not run is a recorded skip.
- `src/vision/rubric.mjs` holds the coherence score and the pure keep/park
  decision table.
- `src/vision/judge.mjs` is the blind per-criterion judge. The labels are
  anonymous and the order is randomized. A malformed answer is a recorded
  failure, never a silent pass.
- `src/gate/archive.mjs` keeps a small archive of the most diverse kept versions.
- `src/gate/direction.mjs` writes the direction for the next step from the
  judge's recorded weaknesses and the least-moved configuration fields.

The mode is `PHYGEN_GATE_MODE`: `off` skips the gate, `warn` records the verdict
and parks nothing, and `park` refuses a step that fails. Warn is the default. The
judge mode is `PHYGEN_JUDGE_MODE`: `borderline` (the default — a paid judgment
only when a free metric is near a floor), `always`, or `off`.

In `park` mode a parked step gets ONE bounded self-repair: a session sees its own
frame and the parent frame, and a machine report of every tripped test, the
scores, and the novelty. A second park is final: the version is stored with
status `parked`, the chain head stays, and the card becomes a thin rejected card.

The floors are fitted from the chain and recorded in `docs/MEASUREMENTS.md`. On
this artwork the `cordRidgeMax` ceiling is inactive, because a healthy physarum
frame is one connected network; the test records a skip.

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
- Each card carries a thin gate strip: the verdict (kept, repaired, parked, or
  "would park" in warn mode). Selecting a version shows the reason panel: the
  metrics, the hard tests, the criterion scores, the novelty, and the direction.
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
