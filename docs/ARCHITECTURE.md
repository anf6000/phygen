# Phygen architecture

This document holds the durable structure and the rules that are easy to get
wrong. It does not repeat the work rules in `AGENTS.md`.

## Layers

```
runtime/            the artwork package contract, shared by every side
threejs/            one artwork package (the physarum simulation)
server/             the controller: records, providers, capture, judging
  src/analysis/     measured relationships between versions
  src/controller/   one run: rounds, candidates, judging, budgets
  src/judge/        the visual comparison protocol
  src/artwork/      package review, workspace, snapshot publication
web/                the interface: rings, cards, detail, measurements
  src/layout/       the pure generation-ring layout
```

## Generation rings

Every node's children are placed around that node, and the arrangement repeats at
every level, so the whole drawing is a recursive circular structure.

- The root is the centre. It has no parent, so its children surround it: a full
  turn.
- Every other node spreads its children over a fan **centred on the direction
  away from its parent**, at most a half turn, so no child is ever placed behind
  its own parent. A fan is capped at a half turn: a full turn is smaller on
  paper, but the children behind the parent collide with the parent's own
  ancestors and the drawing has to spread out to separate them.
- **A brood whose children are all leaves is packed as a BLOCK** at card pitch,
  not as a ring. None of those children needs room to grow outward, and a block
  covers far less area: for one parent of thirty-eight the ring needs a circle of
  radius 1,670, and the block fits the same cards in under 60% of that area. A
  brood with even one branching child keeps the ring, because mixing the two
  arrangements pushes the cards into each other.
- Card depth is the **calculated distance from the canonical root**, counted
  through parent links. A stored `generation` that disagrees is reported; it
  never decides a position.
- Siblings are sorted by creation time, then by ID, so the layout is stable.

Both arrangements clear the real rectangles, not a bounding circle. Two
axis-aligned cards clear each other when their centres are far enough apart on
*either* axis, so a ring radius is solved by bisection against that condition for
every pair — the parent's card, the cards already placed, and the ring's own
cards — and the fixtures assert that no ring wastes room. The block is exact by
construction: its columns sit one card width plus the gap apart, and its rows one
card height plus the gap apart.

A repair pass then measures every placed pair on the real rectangles. When pairs
still overlap, the least uniform factor that clears them all is found by
bisection, and the best result seen is kept: the layout never returns a worse
drawing than the one it started from. The layout reports how many times it grew
and any pair it could not separate, and the interface shows that count.

### Circle packing does not work here

The obvious next idea is to pack each subtree into its own circle and place the
child circles tangent around the parent. It was implemented and measured, and it
is **not** used. A subtree's bounding circle grows with every ancestor's
clearance requirement, so the radius doubles at each level:

| generation | child distance |
| --- | --- |
| 1 | 100,011 |
| 2 | 50,006 |
| 3 | 26,805 |
| 4 | 11,961 |
| 5 | 9,713 |

On the recorded artwork that is a drawing 248,254,760 units wide with four
unresolved overlaps, against 11,707 units for the arrangement above. Circle
packing is only suitable when a subtree fits inside a circle that is small
compared with its parent's clearance, which is not true for a lineage.

The way to pack a deep lineage tighter is a **sector** layout: give every subtree
an angular wedge as well as a radius, and keep its cards inside that wedge. That
is the next real change to this module, and it is not a radius tweak.

### Zoom floor

The canvas never zooms below 0.16, and Fit All clamps to that floor. A card is
260 graph units wide, so 0.16 keeps every card about 42 pixels wide — a target a
person can hit. An overview where 103 cards are 15-pixel specks is not usable,
however much of the artwork it shows at once; the rest of the artwork is reached
by panning or with Focus selection. Drawn lines take no pointer events at all, so
a line can never swallow a click meant for a card.

Positions are calculated before any filter is applied. A filter changes what is
drawn, never where a card is. The canonical root stays visible.

Layout order is **ancestry**. It is not similarity. A viewer must never read a
ring distance as a measured resemblance.

A record whose parent is missing, and a record inside a parent cycle, goes to a
separate diagnostic column. No ancestry is invented for it.

### Lines

Both draw layers are **solid**. Ancestry is black: 3 px on the selected lineage,
1.4 px otherwise, and **straight** — a spoke says "this card hangs from that one".
A measured relationship joins two cards that can sit anywhere, so it is drawn as
a **cubic bow that bends away from the middle of the artwork**; the bow keeps
crossing lines apart and reads as a flowing mesh instead of a knot of chords.

The measured layer is drawn at **every** zoom, the widest overview included, and
keeps its **stroke width on screen** (`vector-effect: non-scaling-stroke`). A
stroke in graph units shrinks with the zoom, so without that the layer would
vanish into hairlines exactly when the whole artwork is in view. The number of
measured lines is bounded (`MAX_RELATIONSHIP_DRAWS`, currently 150, strongest
first) and the layer has its own toggle.

## Measured relationships

A measurement is a record about a **pair of versions**. It never changes a parent
link and never places a card.

Every measure declares:

- a stable `id`, which each record stores;
- a `method`: `deterministic` (no model, no spend) or `model`;
- a `direction`: one sentence that says what a HIGH score means.

A score is a **distance**. A high score means the two versions are less alike.
An unavailable model measure is reported with its reason. It is never replaced by
a silent approximation.

Candidate pairs are bounded and deterministic:

1. every version against its parent;
2. versions of the same round against each other;
3. versions one generation apart;
4. versions that hold the same role;
5. the remaining budget, filled with a seeded shuffle.

The plan never reads a canvas position, so a layout change cannot change the
sample. A record for a pair is reused only when both versions still hold the same
source hash and the same configuration.

## Runs and recovery

- A configured limit that refuses admission stops the run. It does not consume an
  evolution and it is not recorded as a candidate fault.
- A pause stops new paid work. The interrupted round is recorded and does not
  consume an evolution. Resume reuses the candidates the run already published
  and the comparisons it already completed.
- A stop is checked before every provider reservation, before every retry delay,
  and before every process start. A stop can never start another paid session.
- A measurement run is never resumed automatically after a restart. It is marked
  failed, so a half-measured set can never look complete.

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

## Event stream

The client subscribes before the replay starts, so an event cannot slip between
the last replayed page and the subscription. The complete missed range is paged
up to the high-water sequence that was current at subscription time. A client
that cannot keep up is closed with a comment, so it reconnects from its last
sequence and receives exactly what it missed. Events are never trimmed silently.
