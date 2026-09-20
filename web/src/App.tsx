import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { RequestError, api, useRunEvents } from './api';
import { playingVersionId, stepLabels } from './chain';
import type { AgentRow, Health, ModelList, RunDetail, Tree, TreeNode } from './types';
import { Timeline } from './components/Timeline';
import { Shell } from './components/Shell';
import { LiveModal } from './components/LiveModal';

// A build stamp shows in the status line, so a stale tab is easy to spot.
const BUILD_STAMP = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
const SHELL_HEIGHT_KEY = 'phygen.shellHeight';
const ACTIVE_RUN_STATES = ['queued', 'running', 'paused', 'stopping'];

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [artworkId, setArtworkId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [model, setModel] = useState('');
  const [steps, setSteps] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [modalVersionId, setModalVersionId] = useState<string | null>(null);
  const [storedRows, setStoredRows] = useState<AgentRow[]>([]);
  const [shellHeight, setShellHeight] = useState<number | null>(() => {
    const raw = window.localStorage.getItem(SHELL_HEIGHT_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const mainRef = useRef<HTMLDivElement>(null);
  const runId = run?.run.id ?? null;

  const stream = useRunEvents(runId);

  // A new build must not hide behind a stale tab. The served page names the
  // bundle, so a different name means this tab is old: reload it.
  useEffect(() => {
    const loaded = new URL(import.meta.url).pathname.split('/').pop() ?? '';
    if (!loaded.startsWith('index-')) return undefined;
    const timer = window.setInterval(() => {
      void fetch('/', { cache: 'no-store' })
        .then((response) => response.text())
        .then((html) => {
          const served = /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1] ?? '';
          if (served && served !== loaded) window.location.reload();
        })
        .catch(() => {});
    }, 30000);
    return () => window.clearInterval(timer);
  }, []);

  // ── data ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        setHealth(await api.health());
      } catch (cause) {
        setError(describe(cause));
      }
      try {
        const list = await api.models();
        setModels(list);
        setModel((current) => current || list.defaultModel);
      } catch {
        setModels(null);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.artworks();
        if (list.artworks.length > 0) {
          setArtworkId(list.artworks[0].id);
          return;
        }
        const imported = await api.importArtwork('threejs');
        setArtworkId(imported.artwork.id);
      } catch (cause) {
        setError(describe(cause));
      }
    })();
  }, []);

  const loadTree = useCallback(async (id: string) => {
    try {
      setTree(await api.tree(id));
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (artworkId) void loadTree(artworkId);
  }, [artworkId, loadTree]);

  // Show the latest run of this artwork, so a reload does not lose the record.
  useEffect(() => {
    if (run || !artworkId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.runs();
        const latest = list.runs.find((candidate) => candidate.artworkId === artworkId);
        if (!latest || cancelled) return;
        const detail = await api.run(latest.id);
        if (!cancelled) setRun(detail);
      } catch {
        // no run yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artworkId, run]);

  // Refresh the chain while a step works. The run summary is small; the full
  // record is fetched only when the state or the step count changes.
  useEffect(() => {
    if (!artworkId) return undefined;
    const active = run ? ACTIVE_RUN_STATES.includes(run.run.state) : true;
    const timer = window.setInterval(() => {
      void loadTree(artworkId);
      if (runId) {
        void api
          .runSummary(runId)
          .then(async (summary) => {
            if (summary.run.state !== run?.run.state || summary.run.evolutionsDone !== run?.run.evolutionsDone) {
              setRun(await api.run(runId));
            }
          })
          .catch(() => {});
      }
    }, active ? 2000 : 15000);
    return () => window.clearInterval(timer);
  }, [artworkId, loadTree, run, runId]);

  const nodes = tree?.nodes ?? [];
  // A failed step is not part of the chain the interface shows.
  const shownNodes = useMemo(() => nodes.filter((node) => node.status !== 'failed'), [nodes]);
  const playingId = useMemo(() => playingVersionId(shownNodes), [shownNodes]);
  const labels = useMemo(() => stepLabels(shownNodes), [shownNodes]);
  const activeVersionId = tree?.activeVersionIds[0] ?? null;
  const feedVersionId = selected ?? activeVersionId ?? playingId;
  const feedVersion = useMemo(() => nodes.find((node) => node.id === feedVersionId) ?? null, [nodes, feedVersionId]);

  // The shell shows the stored rows of the selected step, and the live rows of
  // the working step. One sequence number means one row.
  useEffect(() => {
    if (!feedVersionId) {
      setStoredRows([]);
      return undefined;
    }
    let cancelled = false;
    void api
      .agentFeed(feedVersionId)
      .then((feed) => {
        if (!cancelled) setStoredRows(feed.rows);
      })
      .catch(() => {
        if (!cancelled) setStoredRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [feedVersionId]);

  const liveRows = useMemo(
    () =>
      stream.events
        .filter((event) => event.type === 'agent')
        .map((event) => ({ seq: event.seq, ...(event.payload as unknown as Omit<AgentRow, 'seq'>) })),
    [stream.events],
  );

  const shellRows = useMemo(() => {
    if (!feedVersionId) return [];
    const merged = new Map<number, AgentRow>();
    for (const row of storedRows) if (row.versionId === feedVersionId) merged.set(row.seq, row);
    for (const row of liveRows) if (row.versionId === feedVersionId) merged.set(row.seq, row);
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
  }, [storedRows, liveRows, feedVersionId]);

  // ── actions ───────────────────────────────────────────────────────────────
  const startRun = async () => {
    if (!artworkId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.startRun({ artworkId, evolutions: steps, model: model || undefined });
      setSelected(null);
      setRun(await api.run(created.run.id));
      await loadTree(artworkId);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectNode = useCallback((versionId: string) => setSelected(versionId), []);

  // ── the resizable split ───────────────────────────────────────────────────
  const dragSplit = (event: ReactMouseEvent) => {
    event.preventDefault();
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const move = (moveEvent: MouseEvent) => {
      const next = Math.min(rect.height - 140, Math.max(140, rect.bottom - moveEvent.clientY));
      setShellHeight(next);
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };

  useEffect(() => {
    if (shellHeight !== null) window.localStorage.setItem(SHELL_HEIGHT_KEY, String(shellHeight));
  }, [shellHeight]);

  const active = run ? ACTIVE_RUN_STATES.includes(run.run.state) : false;
  const visionModels = models?.models.filter((entry) => entry.acceptsImages) ?? [];
  const modalVersion = modalVersionId ? nodes.find((node) => node.id === modalVersionId) ?? null : null;

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-title">
          <strong>phygen</strong>
          <span className="muted">{tree?.artwork.title ?? 'artwork evolution'}</span>
        </div>
        <form
          className="bar-form"
          onSubmit={(event) => {
            event.preventDefault();
            void startRun();
          }}
        >
          <label className="field">
            <span>Model</span>
            <select value={model} onChange={(event) => setModel(event.target.value)} disabled={active || busy}>
              {visionModels.length === 0 ? <option value={model}>{model || 'no catalog'}</option> : null}
              {visionModels.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} — in {entry.priceInUsdPerMTok.toFixed(2)} / out {entry.priceOutUsdPerMTok.toFixed(2)} USD per M
                </option>
              ))}
            </select>
          </label>
          <label className="field narrow">
            <span>Steps</span>
            <input
              type="number"
              min={1}
              max={100}
              value={steps}
              onChange={(event) => setSteps(Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))))}
              disabled={active || busy}
            />
          </label>
          <button type="submit" className="primary" disabled={active || busy || !tree}>
            {active ? 'Working…' : 'Evolve'}
          </button>
        </form>
      </header>

      {health?.provider.substituted ? (
        <div className="notice notice-alert" role="alert">
          <strong>The provider is a TEST DOUBLE.</strong> The agent is a deterministic stub, so this work is not real. Start the server
          with <code>PHYGEN_DRIVER=pi</code> and <code>PHYGEN_ALLOW_SPEND=1</code> for real evolution.
        </div>
      ) : null}

      {error ? (
        <div className="alert" role="alert">
          <strong>{error.code}</strong> {error.message}
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}

      <main className="main" ref={mainRef}>
        <div className="chain-area">
          <Timeline
            nodes={nodes}
            activeVersionIds={tree?.activeVersionIds ?? []}
            activeKinds={tree?.activeKinds ?? {}}
            playingId={playingId}
            livePaused={modalVersionId !== null}
            selected={selected}
            onSelect={selectNode}
            onOpen={setModalVersionId}
          />
        </div>
        <div
          className="split-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the agent log"
          onMouseDown={dragSplit}
        >
          <span className="split-grip" />
        </div>
        <div className="shell-wrap" style={{ height: shellHeight !== null ? `${shellHeight}px` : '50%' }}>
          <Shell rows={shellRows} label={shellLabel(feedVersion, labels, feedVersionId === activeVersionId)} active={Boolean(activeVersionId && feedVersionId === activeVersionId)} />
        </div>
      </main>

      <footer className="strip" role="status">
        <span className="pill">
          state <strong>{run?.run.state ?? 'no run'}</strong>
        </span>
        <span className="pill">
          step <strong>{run ? `${run.run.evolutionsDone} of ${run.run.evolutionsRequested}` : '—'}</strong>
        </span>
        <span className="pill">
          spend <strong>{run ? run.run.spentUsd.toFixed(4) : '0.0000'}</strong> USD
        </span>
        <span className="pill">
          provider <strong>{health?.provider.driver ?? '—'}</strong>
          {run?.run.protocol?.providerModel ? ` · ${run.run.protocol.providerModel}` : health?.provider.model ? ` · ${health.provider.model}` : ''}
        </span>
        <span className="pill">
          stream <strong>{stream.connected ? 'live' : 'idle'}</strong>
        </span>
        {run?.run.stopReason ? <span className="pill warn">{run.run.stopReason}</span> : null}
        <span className="pill muted">ui {BUILD_STAMP}</span>
      </footer>

      {modalVersion ? <LiveModal version={modalVersion} onClose={() => setModalVersionId(null)} /> : null}
    </div>
  );
}

function describe(cause: unknown): { code: string; message: string } {
  if (cause instanceof RequestError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: 'failed', message: cause.message };
  return { code: 'failed', message: String(cause) };
}

/** The shell header: the card name, its title when it has one, and the working mark. */
function shellLabel(version: TreeNode | null, labels: Record<string, string>, working: boolean): string {
  if (!version) return 'the agent log';
  const label = labels[version.id] ?? (version.generation > 0 ? `Step ${version.generation}` : 'Root');
  const title = /^Step \d+$/.test(version.title) ? null : version.title;
  return `${label}${title ? ` — ${title}` : ''}${working ? ' (working)' : ''}`;
}
