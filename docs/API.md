# Phygen API contract

Version 1.0.0. The interface and the server share this document. Change it
before you change either side.

Base path: `/api`. The server listens on `PHYGEN_PORT` (default 8787). In
development, Vite serves the interface on port 5173 and proxies `/api` to the
server.

## Health

`GET /api/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "provider": { "driver": "pi", "model": "moonshotai/kimi-k3", "ready": true },
  "capture": { "backend": "local", "available": true, "detail": "chrome channel" },
  "isolation": { "docker": false, "detail": "docker daemon unreachable" },
  "artworks": 1,
  "models": { "source": "gateway", "count": 367 }
}
```

## Models

`GET /api/models` returns the Kilo catalog with prices per million tokens.

```json
{
  "source": "gateway",
  "count": 367,
  "fetchedAt": "2026-09-15T14:20:00.000Z",
  "defaultModel": "moonshotai/kimi-k3",
  "authorModel": "moonshotai/kimi-k3",
  "models": [
    {
      "id": "moonshotai/kimi-k3",
      "name": "MoonshotAI: Kimi K3",
      "acceptsImages": true,
      "contextWindow": 1048576,
      "priceInUsdPerMTok": 3,
      "priceOutUsdPerMTok": 15,
      "free": false
    }
  ]
}
```

`source` is `gateway` for a fresh catalog, `cache` for the saved copy, and
`unavailable` when neither exists. A judge model must accept images.

## Artworks

`GET /api/artworks` → `{ "artworks": [Artwork] }`

`Artwork`

```json
{
  "id": "art_8f2c",
  "packageId": "physarum",
  "title": "Physarum transport network",
  "contractVersion": "1.0.0",
  "packagePath": "threejs",
  "createdAt": "2026-09-15T13:20:00.000Z",
  "rootVersionId": "ver_0001",
  "versionCount": 4
}
```

`POST /api/artworks/import` with `{ "packagePath": "threejs" }` → `{ "artwork": Artwork }`.
The server validates the package first. A rejected package returns HTTP 400 with
`{ "error": { "code": "package_invalid", "message": "…", "problems": ["…"] } }`.

`GET /api/artworks/:artworkId/tree` →

```json
{
  "artwork": Artwork,
  "nodes": [Node],
  "edges": [Edge],
  "activeRunId": "run_9c1a",
  "activeVersionIds": ["ver_0004"],
  "activeKinds": { "ver_0004": "capture" }
}
```

`activeRunId` names the run that is queued, running, paused, or stopping.
`activeVersionIds` lists the versions a worker holds at this moment, and
`activeKinds` gives the job kind for each. The interface uses them for the
progress bar and the active-node leader. Both are empty when nothing runs.

`Node` — one artwork version. The tree is laid out left to right by generation.

```json
{
  "id": "ver_0001",
  "parentId": null,
  "generation": 0,
  "round": null,
  "slot": null,
  "title": "Root",
  "status": "promoted",
  "direction": "light background, thin directional connections",
  "thumbnailUrl": "/api/versions/ver_0001/artifacts/thumb",
  "livePath": "/live/ver_0001",
  "liveUrl": "http://127.0.0.1:8788/v/ver_0001/",
  "sourceHash": "b941ac34…",
  "createdAt": "2026-09-15T13:20:00.000Z",
  "onLineage": true,
  "usageUsd": 0.0123,
  "error": null
}
```

`status` is one of
`queued | authoring | validating | capturing | judging | promoted | rejected | failed | paused`.

`Edge` → `{ "id": "e_ver_0002", "source": "ver_0001", "target": "ver_0002", "onLineage": true }`

`GET /api/versions/:versionId` → full detail

```json
{
  "version": Node,
  "configuration": { "palette": "white", "num": 4000, "seed": 1337 },
  "changes": [
    { "path": "src/physarum.js", "summary": "sensor fan widened", "added": 12, "removed": 4 }
  ],
  "explanation": "Text from the author session.",
  "snapshotPath": "snapshots/physarum/b941ac34…",
  "captures": [
    { "id": "cap_1", "stage": "early", "step": 400, "seed": 1337,
      "url": "/api/captures/cap_1.png", "width": 768, "height": 768,
      "rendererBackend": "ANGLE (NVIDIA, GeForce RTX 3090…)", "sourceHash": "…" }
  ],
  "evaluations": [
    { "id": "ev_1", "kind": "round", "order": ["A", "B", "C", "D"], "labels": { "A": "ver_0001" },
      "winnerVersionId": "ver_0004", "confidence": 0.62, "uncertainty": "low",
      "observations": ["…"], "weaknesses": ["…"], "judgeSession": "sess_…",
      "createdAt": "2026-09-15T13:24:00.000Z" }
  ],
  "usage": [ { "model": "kimi-k3", "inputTokens": 5210, "outputTokens": 380, "costUsd": 0.0071 } ]
}
```

`GET /api/versions/:versionId/artifacts/:name` returns an image.
`name` is `thumb` or a capture stage name (`early`, `middle`, `late`, `dense`).

## Live artwork

`/live/:versionId` returns a full HTML page that plays that version. The server
serves this page on a separate path with a restrictive CSP, and the interface
embeds it in an `iframe` with `sandbox="allow-scripts"`. The page reads the
version configuration and the source snapshot from the version record. It sets
`window.__ready` when the artwork is initialized and shows a diagnostic when the
load fails.

## Runs

`GET /api/cost-estimate?evolutions=3&model=moonshotai/kimi-k3&authorModel=moonshotai/kimi-k3` →

```json
{
  "evolutions": 3,
  "variants": 2,
  "candidatesPerRound": 3,
  "authorCalls": 18,
  "judgeCalls": 18,
  "imagesPerJudgeCall": 12,
  "tokens": {
    "authorInputPerCall": 1800, "authorOutputPerCall": 4000,
    "judgeInputPerCall": 10944, "judgeOutputPerCall": 900,
    "totalInput": 229392, "totalOutput": 88200
  },
  "estimateUsd": 2.011,
  "boundUsd": 3.62,
  "safetyFactor": 1.8,
  "pricingSource": "catalog",
  "authorModel": { "id": "moonshotai/kimi-k3", "known": true, "priceInUsdPerMTok": 3, "priceOutUsdPerMTok": 15 },
  "judgeModel": { "id": "moonshotai/kimi-k3", "known": true, "priceInUsdPerMTok": 3, "priceOutUsdPerMTok": 15 },
  "note": "The estimate uses catalog prices and an estimated token count. Provider usage is authoritative."
}
```

`authorCalls` includes the one bounded repair attempt per candidate. The run
reserves `boundUsd` before each request. When no catalog price is available,
`pricingSource` is `configured` and the conservative configured bounds apply.

`POST /api/runs`

```json
{
  "artworkId": "art_8f2c",
  "branchFromVersionId": "ver_0001",
  "evolutions": 3,
  "variants": 2,
  "direction": "quieter, more directional, fewer crossings",
  "model": "moonshotai/kimi-k3",
  "authorModel": "moonshotai/kimi-k3",
  "spendingLimitUsd": 0,
  "evaluation": {
    "stepSchedule": [600, 1800, 3600],
    "denseStepSchedule": [600, 1200, 1800, 2700, 3600],
    "seeds": [1337, 7],
    "viewport": { "width": 768, "height": 768, "dpr": 1 },
    "tieBreak": true
  }
}
```

→ HTTP 201 `{ "run": Run }`. No cost limit is enforced by default: the record
keeps the real spend, and a run is never refused for money. Send a positive
`spendingLimitUsd` to add a limit. `variants` is the number of children each
evolution spawns, from 1 to 8. `evolutions` is the number of levels, from 1 to
50. The winner of each level becomes the parent of the next level.

`Run`

```json
{
  "id": "run_9c1a",
  "artworkId": "art_8f2c",
  "rootVersionId": "ver_0001",
  "direction": "…",
  "evolutionsRequested": 3,
  "evolutionsDone": 1,
  "state": "running",
  "stopReason": null,
  "spentUsd": 0.31,
  "reservedUsd": 0.42,
  "limitUsd": 2.0,
  "costBoundUsd": 0.9,
  "unchangedRounds": 0,
  "createdAt": "…",
  "updatedAt": "…",
  "rounds": [
    { "round": 1, "parentVersionId": "ver_0001", "candidateIds": ["ver_0002", "ver_0003", "ver_0004"],
      "winnerVersionId": "ver_0004", "promoted": true, "note": "candidate C won" }
  ]
}
```

`state` is one of `queued | running | paused | stopping | stopped | completed | failed`.

`GET /api/runs?limit=20` → `{ "runs": [Run] }`
`GET /api/runs/:runId` → `{ "run": Run, "jobs": [Job], "usage": [Usage] }`

`Job` → `{ "id", "runId", "round", "slot", "kind", "state", "attempts", "errorCode", "errorMessage", "createdAt", "updatedAt" }`.
`kind` is one of `author | capture | judge | publish`.
`state` is one of `queued | running | done | failed | cancelled`.

`POST /api/runs/:runId/pause` → `{ "run": Run }`. New tasks stop; the current
bounded task finishes.
`POST /api/runs/:runId/resume` → `{ "run": Run }`
`POST /api/runs/:runId/stop` → `{ "run": Run }`. Active tasks are cancelled where
the driver supports it.

## Events

`GET /api/runs/:runId/events` — `text/event-stream`. Each frame is
`data: {json}\n\n`. Send `Last-Event-ID` to replay from a sequence number.

```json
{ "seq": 42, "type": "job.state", "at": "2026-09-15T13:23:11.000Z",
  "runId": "run_9c1a", "payload": { "jobId": "job_7", "kind": "capture", "state": "done" } }
```

Event types:

| type | payload |
| --- | --- |
| `run.state` | `{ "state": "running", "stopReason": null }` |
| `run.round` | `{ "round": 1, "phase": "capture" }` |
| `job.state` | `{ "jobId", "kind", "state", "detail" }` |
| `version.created` | `{ "version": Node }` |
| `version.state` | `{ "versionId", "status", "detail" }` |
| `capture.ready` | `{ "versionId", "captureId", "stage", "url" }` |
| `comparison.result` | `{ "round", "labels", "order", "winnerVersionId", "confidence", "uncertainty" }` |
| `usage` | `{ "model", "inputTokens", "outputTokens", "costUsd", "spentUsd", "limitUsd" }` |
| `budget` | `{ "spentUsd", "reservedUsd", "limitUsd", "boundUsd" }` |
| `run.completed` | `{ "state", "stopReason", "evolutionsDone" }` |
| `error` | `{ "code", "message", "detail" }` |
| `log` | `{ "level": "info", "message" }` |

The stream sends a `: keep-alive` comment every 15 seconds. The client
reconnects with `Last-Event-ID` and must not lose or duplicate a node.

## Errors

Every failure uses the same body.

```json
{ "error": { "code": "budget_exceeded", "message": "…", "detail": {} } }
```

Codes: `package_invalid`, `artwork_not_found`, `version_not_found`,
`run_not_found`, `run_state_invalid`, `budget_exceeded`, `provider_unavailable`,
`capture_unavailable`, `isolation_required`, `payload_invalid`.
