# phygen

Phygen evolves a generative artwork through Pi agents. One button starts a run of
X **steps**. Each step makes exactly one child of the newest good version, so the
artwork grows as a forward chain. The interface is read-only: you watch the
chain, the frames, the agent log, and the spend.

![flow](docs/flow.svg)

How the whole system works, from the package contract to the capture layer, is in
[DOCUMENTATION.md](DOCUMENTATION.md).

## What is here

| Path | Contents |
| --- | --- |
| `runtime/` | The artwork contract, the schema validator, the strict configuration loader, the manifest rules, and the Node package checks. |
| `threejs/` | The `physarum` artwork package: manifest, configuration schema, simulation, renderer, and the runtime adapter. |
| `server/` | The controller, storage, capture, providers, API, and the separate artwork origin. |
| `web/` | The React and TypeScript interface. |
| `docs/` | The API contract, the capture measurements, and the interface images. |
| `data-evolve/`, `snapshots/` | Records, captures, and immutable source snapshots. Not source. |

## Install

```bash
cd server && npm install
cd ../web && npm install
```

## Run

```bash
cd server && npm start
```

Then open <http://127.0.0.1:8787/>. The controller serves the interface on 8787
and the artwork on 8788. The artwork origin has no API and no credentials, and
it is kept separate on purpose.

The first page load imports the `threejs` package as the root version, the
mother of the chain. Press **Evolve** to start a run.

## Test

```bash
cd server && npm test      # the step loop, budgets, storage, events
cd threejs && npm test     # artwork package: seeds, reset, bounds, adapter
cd threejs && npm run validate
cd web && npm test         # the chain order and the playing rule
cd web && npm run build
```

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `PHYGEN_ALLOW_SPEND` | unset | Model calls are refused until you set this to `1`. |
| `PHYGEN_DRIVER` | `auto` | `pi` uses the Pi sessions. `fake` uses the deterministic test double. |
| `PHYGEN_PI_ENTRY` | unset | The Pi CLI entry. Set this on Windows, where `pi` is a `.cmd` shim. |
| `PHYGEN_MODEL` | `deepseek/deepseek-v4.1-flash` | The model of the run. The step session must accept images. |
| `PHYGEN_AUTHOR_MODEL` | same as `PHYGEN_MODEL` | The author model. |
| `PHYGEN_AUTHOR_THINKING` | `high` | Author effort. |
| `PHYGEN_MAX_RUN_USD` | `0` | A cost limit. `0` enforces none. |
| `PHYGEN_COST_SAFETY_FACTOR` | `1.8` | The reserve is this multiple of the estimate. |
| `PHYGEN_REQUIRE_ISOLATION` | `0` | Set to `1` to refuse source-code children without a container. |
| `PHYGEN_CAPTURE` | `auto` | `local`, `docker`, or `auto`. |
| `PHYGEN_PORT`, `PHYGEN_LIVE_PORT` | `8787`, `8788` | The two listeners. |
| `PHYGEN_DATA` | `data-evolve` | The records directory. |

Cost estimates use the live Kilo catalog prices and an estimated token count.
Provider usage is authoritative. No cost guardrail is enforced by default: the
record keeps the real spend, and a run is never stopped or refused for money.
Set `PHYGEN_MAX_RUN_USD` if you want a limit.

## The step, in one paragraph

The controller reads the chain head, copies the parent package into a fresh
workspace, and runs one author session with a fixed instruction, the manifest
rules, the parent configuration, the history of this run, and the last three
frames of the chain. It reviews the edits against the manifest, validates the
package and the configuration, publishes the snapshot, captures one late square
frame (1024 x 1024, seed 1337, step 2500), and promotes the child. A technical
failure gets one repair session; a second failure marks the version `failed`,
keeps the chain head, and the next step starts from the last good version.

There is **no quality gate**. Every child that passes the package checks is kept,
whatever it looks like. The chain is the record, and a person judges the frames.

## Boundaries

Generated and imported code is untrusted. Candidates run in the artwork page on
a separate origin with a strict content policy, no credentials, no network, and
no host directory access. A container boundary is stronger and is available
through `PHYGEN_CAPTURE=docker`; without it, set `PHYGEN_REQUIRE_ISOLATION=1` and
the controller refuses source-code children.

The API has no authentication and no CSRF control. Keep it on the loopback
address until that work is done.
