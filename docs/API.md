# Phygen API contract

Version 1.0.0. The interface and the server share this document. Change it
before you change either side.

Base path: `/api`. The server listens on `PHYGEN_PORT` (default 8787). In
development, Vite serves the interface on port 5173 and proxies `/api` to the
server. The artwork origin listens on `PHYGEN_LIVE_PORT` (default 8788).

## Health

`GET /api/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "provider": {
    "driver": "pi",
    "model": "deepseek/deepseek-v4.1-flash",
    "ready": true,
    "substituted": false,
    "allowSpend": true,
    "detail": "0.85.1"
  },
  "capture": { "backend": "local", "available": true, "isolated": false, "detail": "chrome 153.0.8010.36" },
  "isolation": { "docker": false, "image": null, "detail": "docker daemon unreachable" },
  "artworks": 1,
  "models": { "source": "gateway", "count": 371 }
}
```

`provider.substituted` is true when the deterministic test double replaced a
provider that could not start. `provider.allowSpend` is false until
`PHYGEN_ALLOW_SPEND=1`.

## Models

`GET /api/models` returns the Kilo catalog with prices per million tokens.

```json
{
  "source": "gateway",
  "count": 371,
  "fetchedAt": "2026-09-19T05:31:00.000Z",
  "defaultModel": "deepseek/deepseek-v4.1-flash",
  "models": [
    {
      "id": "deepseek/deepseek-v4.1-flash",
      "name": "DeepSeek: DeepSeek V4.1 Flash",
      "acceptsImages": true,
      "contextWindow": 128000,
      "priceInUsdPerMTok": 0.3,
      "priceOutUsdPerMTok": 1.2,
      "free": false
    }
  ]
}
```

`source` is `gateway` for a fresh catalog, `cache` for the saved copy, and
`unavailable` when neither exists. A model used by a step MUST accept images:
the step session reads the frames of the chain.

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
  "createdAt": "2026-09-19T05:36:00.000Z",
  "rootVersionId": "ver_0001",
  "versionCount": 26
}
```

`POST /api/artworks/import` with `{ "packagePath": "threejs" }` → HTTP 201
`{ "artwork": Artwork }`. The server validates the package first, and the import
is idempotent for one package path. A rejected package returns HTTP 400 with
`{ "error": { "code": "package_invalid", "message": "…", "detail": { "problems": ["…"] } } }`.

The root version of the chain is the imported package, exactly as it was.

## The chain

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
`activeKinds` gives the job kind for each. Both are empty when nothing runs.

`Node` — one version in the forward chain. `nodes` is ordered by generation, and
the interface renders it newest first.

```json
{
  "id": "ver_0004",
  "parentId": "ver_0003",
  "generation": 4,
  "step": 4,
  "title": "The trail now spreads wider",
  "status": "promoted",
  "palette": "white",
  "stillUrl": "/api/captures/cap_9.png",
  "stillStage": "late",
  "stillStep": 2500,
  "livePath": "/live/ver_0004",
  "liveUrl": "http://127.0.0.1:8788/v/ver_0004/",
  "sourceHash": "b941ac34…",
  "createdAt": "2026-09-19T05:44:00.000Z",
  "onLineage": true,
  "changes": [{ "path": "src/physarum.js", "status": "changed", "added": 12, "removed": 4 }],
  "explanation": "Text from the author session.",
  "stub": false,
  "usageUsd": 0.0017,
  "tokens": 3108,
  "error": null
}
```

`status` is one of `queued | authoring | validating | capturing | promoted | failed`.

- Exactly one version plays live: the newest one with status `promoted`. Every
  other version shows `stillUrl`, its stage, or its failure reason.
- `step` is the position in the chain, from 1. The root holds `null`. It is the
  generation, so it stays right when a second run continues the chain. The run's
  own `rounds` count that run's steps, from 1.
- `changes` names what THIS step changed, against its parent.
- `stub` is true when the run used the deterministic test double.
- `error` is `{ "code", "message" }` for a failed version.

`Edge` → `{ "id": "e_ver_0004", "source": "ver_0003", "target": "ver_0004", "onLineage": true }`

## Versions

`GET /api/versions/:versionId` → full detail

```json
{
  "version": Node,
  "configuration": { "palette": "white", "num": 4000, "seed": 1337 },
  "changes": [{ "path": "src/physarum.js", "status": "changed", "added": 12, "removed": 4 }],
  "explanation": "Text from the author session.",
  "snapshotPath": "snapshots/physarum/b941ac34…",
  "captures": [
    {
      "id": "cap_9", "stage": "late", "step": 2500, "seed": 1337,
      "width": 1024, "height": 1024, "dpr": 1,
      "rendererBackend": "ANGLE (NVIDIA, GeForce RTX 3090…)",
      "sourceHash": "…", "configurationHash": "…", "timestep": 8,
      "url": "/api/captures/cap_9.png", "createdAt": "2026-09-19T05:45:00.000Z"
    }
  ],
  "usage": [{ "kind": "author", "model": "deepseek/deepseek-v4.1-flash", "inputTokens": 520, "outputTokens": 495, "costUsd": 0.001057 }],
  "error": null
}
```

`GET /api/versions/:versionId/agent` → `{ "rows": [AgentRow], "files": [FileRow] }`

The stored agent feed of one version, so a finished version still shows how it
was made.

```json
{ "seq": 41, "at": "…", "versionId": "ver_0004", "kind": "reason", "text": "The parent already doubled the particles…" }
```

`kind` is one of:

| kind | fields |
| --- | --- |
| `reason` | `text` (the agent reasoning, dim in the shell) |
| `text` | `text` (the agent answer) |
| `tool` | `tool`, `path`, `added`, `removed`, `edits`, `writes`, `state`, `ok` |
| `turn` | `tokens`, `costUsd` |

Every row holds at most 4000 characters.

`GET /api/versions/:versionId/artifacts/:name` returns an image. `name` is a
capture stage name (`late`). The newest capture is used when the name does not
match a stage.

`GET /api/captures/:captureId.png` returns one captured frame. The response
carries a strong `etag`, so a second request returns HTTP 304.

## Operator actions

The interface has no button for these. They exist for an operator, and the tool
`server/tools/repair-version.mjs` does the same work from a terminal.

`POST /api/versions/:versionId/repair` repairs ONE failed version and continues
its step:

1. The failed candidate's own published snapshot becomes the workspace, so the
   repair fixes the code that failed instead of throwing the attempt away.
2. One bounded repair session runs, with the failure code and text.
3. The package is validated against the parent, published, and captured.
4. The version is promoted.

This is the only path from `failed` back to `promoted`. It is refused while a run
is active on the artwork. A failure returns
`{ "error": { "code", "message", "detail" } }` with the reason of the failed step.

`POST /api/versions/:versionId/capture` captures one frame for a version that has
none. The imported root uses it, so its card shows a real frame. A version that
already holds a capture returns the existing captures.

```bash
node tools/repair-version.mjs --version <versionId>                 # repair a failed step
node tools/repair-version.mjs --version <versionId> --capture-only  # capture a frame
```

The import route starts the root frame capture in the background, so the first
page load stays fast and the root card shows a real frame as soon as it lands.

## Live artwork

`/live/:versionId` returns a full HTML page that plays that version. The server
serves this page with a restrictive CSP, and the interface embeds it in an
`iframe` with `sandbox="allow-scripts"`. The artwork itself runs on the separate
origin, which has no API and no credentials.

## Runs

`POST /api/runs`

```json
{
  "artworkId": "art_8f2c",
  "evolutions": 25,
  "model": "deepseek/deepseek-v4.1-flash",
  "spendingLimitUsd": 0
}
```

→ HTTP 201 `{ "run": Run }`.

- `evolutions` is the number of steps, from 1 to 100. One step makes exactly one
  child of the newest good version.
- `model` is optional. The default is `PHYGEN_MODEL`. The model must be in the
  catalog and must accept images.
- `spendingLimitUsd` is optional. No cost limit is enforced by default: the
  record keeps the real spend, and a run is never refused for money. A positive
  value adds a limit. A configured limit that refuses admission stops the run; it
  does not consume a step.

`Run`

```json
{
  "id": "run_9c1a",
  "artworkId": "art_8f2c",
  "rootVersionId": "ver_0001",
  "evolutionsRequested": 25,
  "evolutionsDone": 7,
  "state": "running",
  "stopReason": null,
  "limitUsd": 0,
  "spentUsd": 0.0112,
  "reservedUsd": 0.3,
  "calls": 7,
  "tokens": 21500,
  "costBoundUsd": 15,
  "protocol": {
    "viewport": { "width": 1024, "height": 1024, "dpr": 1 },
    "seeds": [1337],
    "frameRoles": ["late"],
    "stepSchedule": [2500],
    "providerDriver": "pi",
    "providerModel": "deepseek/deepseek-v4.1-flash",
    "authorModel": "deepseek/deepseek-v4.1-flash"
  },
  "createdAt": "…",
  "updatedAt": "…",
  "rounds": [
    {
      "round": 1,
      "parentVersionId": "ver_0001",
      "candidateIds": ["ver_0002"],
      "winnerVersionId": "ver_0002",
      "promoted": true,
      "note": "The change is in place. evolved from Root."
    }
  ]
}
```

`state` is one of `queued | running | paused | stopping | stopped | completed | failed`.

A round with `promoted: false` and one failed candidate means the step failed a
technical check; the next step starts from the same parent.

`GET /api/runs?limit=20` → `{ "runs": [Run] }` (round 0 is not included)

`GET /api/runs/:runId` → `{ "run": Run, "jobs": [Job], "usage": [Usage], "active": true }`

`GET /api/runs/:runId/summary` → `{ "run": Run, "active": true }`. The interface
polls this while a run moves. It stays small on purpose.

`Job` → `{ "id", "runId", "versionId", "round", "kind", "state", "attempts", "errorCode", "errorMessage", "createdAt", "updatedAt" }`.
`kind` is one of `author | capture | publish`.
`state` is one of `queued | running | done | failed | cancelled`.

`POST /api/runs/:runId/pause` → `{ "run": Run }`. New steps stop; the current
bounded step finishes.
`POST /api/runs/:runId/resume` → `{ "run": Run }`
`POST /api/runs/:runId/stop` → `{ "run": Run }`. Active tasks are cancelled where
the driver supports it.

The interface shows no pause, resume, or stop button. The routes exist for the
restart recovery path and for an operator.

## Events

`GET /api/runs/:runId/events` — `text/event-stream`. Each frame is
`data: {json}\n\n`. Send `Last-Event-ID` to replay from a sequence number.

```json
{ "seq": 42, "type": "job.state", "at": "2026-09-19T05:43:11.000Z",
  "runId": "run_9c1a", "payload": { "jobId": "job_7", "kind": "capture", "state": "done" } }
```

Event types:

| type | payload |
| --- | --- |
| `run.state` | `{ "state": "running", "stopReason": null }` |
| `run.round` | `{ "round": 1, "phase": "author" \| "done" \| "interrupted", "parentVersionId", "promoted", "note" }` |
| `job.state` | `{ "jobId", "kind", "state", "detail" }` |
| `version.created` | `{ "version": Node }` |
| `version.state` | `{ "versionId", "status", "detail", "errorCode" }` |
| `capture.ready` | `{ "versionId", "captureId", "stage", "step", "seed", "url" }` |
| `agent` | one AgentRow, with `versionId` |
| `file` | `{ "versionId", "kind": "inventory" \| "change", "path", "lines", "bytes", "added", "removed" }` |
| `usage` | `{ "model", "inputTokens", "outputTokens", "costUsd", "costSource", "spentUsd", "limitUsd" }` |
| `budget` | `{ "spentUsd", "reservedUsd", "limitUsd", "boundUsd" }` |
| `run.completed` | `{ "state", "stopReason", "evolutionsDone" }` |
| `error` | `{ "code", "message", "detail" }` |
| `log` | `{ "level": "info", "message" }` |

The stream sends a `: keep-alive` comment every 15 seconds. The client
reconnects with `Last-Event-ID` and must not lose or duplicate a row.

## The interface

Every other path returns the built interface (`web/dist/index.html`). When the
interface is not built, the server returns a page that says so.

## Errors

Every failure uses the same body.

```json
{ "error": { "code": "budget_exceeded", "message": "…", "detail": {} } }
```

Codes: `package_invalid`, `artwork_not_found`, `version_not_found`,
`run_not_found`, `capture_not_found`, `not_found`, `payload_invalid`,
`run_state_invalid`, `budget_exceeded`, `request_limit_reached`,
`token_limit_reached`, `round_limit_reached`, `time_limit_reached`,
`capture_unavailable`, `isolation_required`, `provider_unavailable`,
`internal_error`.
