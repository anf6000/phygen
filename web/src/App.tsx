import { useCallback, useEffect, useMemo, useState } from 'react';

import { RequestError, api, useRunEvents } from './api';
import type { CostEstimate, Health, ModelList, RunDetail, Tree } from './types';
import { TreeView } from './components/TreeView';
import { GenerationList } from './components/GenerationList';
import { DetailPanel } from './components/DetailPanel';
import { CaptureViewer } from './components/CaptureViewer';

const DEFAULT_DIRECTION = 'quieter, more directional, fewer crossings, light background';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [artworkId, setArtworkId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewerVersion, setViewerVersion] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [direction, setDirection] = useState(DEFAULT_DIRECTION);
  const [evolutions, setEvolutions] = useState(1);
  const [limitUsd, setLimitUsd] = useState(0.5);
  const [models, setModels] = useState<ModelList | null>(null);
  const [judgeModel, setJudgeModel] = useState('');
  const [authorModel, setAuthorModel] = useState('');
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const runId = run?.run.id ?? null;

  const stream = useRunEvents(runId);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

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
        setJudgeModel((current) => current || list.defaultModel);
        setAuthorModel((current) => current || list.authorModel);
      } catch {
        setModels(null);
      }
    })();
  }, []);

  const loadTree = useCallback(async (id: string) => {
    try {
      const next = await api.tree(id);
      setTree(next);
      setSelected((current) => current ?? next.artwork.rootVersionId);
    } catch (cause) {
      setError(describe(cause));
    }
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

  useEffect(() => {
    void api
      .estimate(evolutions, judgeModel || undefined, authorModel || undefined)
      .then((next) => {
        setEstimate(next);
        setLimitUsd((current) => (current >= next.boundUsd ? current : Number(next.boundUsd.toFixed(2))));
      })
      .catch(() => setEstimate(null));
  }, [evolutions, judgeModel, authorModel]);

  // Refresh the tree while a run moves. The run summary is small; the full
  // record (jobs, usage, comparisons) is fetched only when the state changes.
  useEffect(() => {
    if (!artworkId) return undefined;
    const active = run ? !['stopped', 'completed', 'failed'].includes(run.run.state) : true;
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

  const startRun = async () => {
    if (!artworkId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.startRun({
        artworkId,
        direction,
        evolutions,
        spendingLimitUsd: limitUsd,
        model: judgeModel || undefined,
        authorModel: authorModel || undefined,
      });
      setRun(await api.run(created.run.id));
      if (artworkId) await loadTree(artworkId);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const control = async (action: 'pause' | 'resume' | 'stop') => {
    if (!runId) return;
    setError(null);
    try {
      await api.control(runId, action);
      setRun(await api.run(runId));
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const running = run ? ['queued', 'running', 'paused', 'stopping'].includes(run.run.state) : false;
  const nodes = tree?.nodes ?? [];
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selected) ?? null, [nodes, selected]);
  const playingNode = useMemo(() => nodes.find((node) => node.id === playing) ?? null, [nodes, playing]);
  const visionModels = models?.models.filter((model) => model.acceptsImages) ?? [];

  return (
    <div className="app">
      <header className="bar">
        <div className="bar-title">
          <strong>phygen</strong>
          <span className="muted">{tree?.artwork.title ?? 'artwork evolution'}</span>
          {health ? (
            <span className="pill muted">
              provider {health.provider.driver} · capture {health.capture.backend}
              {health.capture.isolated ? ' (isolated)' : ' (sandboxed page)'}
            </span>
          ) : null}
        </div>
        <form
          className="bar-form"
          onSubmit={(event) => {
            event.preventDefault();
            void startRun();
          }}
        >
          <label className="field wide">
            <span>Direction</span>
            <input
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              placeholder="which way should the artwork evolve?"
              disabled={running}
            />
          </label>
          <label className="field">
            <span>Evolutions</span>
            <input
              type="number"
              min={1}
              max={20}
              value={evolutions}
              onChange={(event) => setEvolutions(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
              disabled={running}
            />
          </label>
          <label className="field">
            <span>Judge model</span>
            <select value={judgeModel} onChange={(event) => setJudgeModel(event.target.value)} disabled={running}>
              {visionModels.length === 0 ? <option value={judgeModel}>{judgeModel || 'no catalog'}</option> : null}
              {visionModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} — in {model.priceInUsdPerMTok.toFixed(2)} / out {model.priceOutUsdPerMTok.toFixed(2)} USD per M
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Author model</span>
            <select value={authorModel} onChange={(event) => setAuthorModel(event.target.value)} disabled={running}>
              {models?.models.length ? null : <option value={authorModel}>{authorModel || 'no catalog'}</option>}
              {(models?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} — in {model.priceInUsdPerMTok.toFixed(2)} / out {model.priceOutUsdPerMTok.toFixed(2)} USD per M
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Limit (USD)</span>
            <input
              type="number"
              min={0.05}
              step={0.05}
              value={limitUsd}
              onChange={(event) => setLimitUsd(Math.max(0.05, Number(event.target.value) || 0.05))}
              disabled={running}
            />
          </label>
          <div className="bar-actions">
            <button type="submit" className="primary" disabled={running || busy || !tree}>
              Start
            </button>
            <button type="button" onClick={() => void control('pause')} disabled={!run || run.run.state !== 'running'}>
              Pause
            </button>
            <button type="button" onClick={() => void control('resume')} disabled={!run || run.run.state !== 'paused'}>
              Resume
            </button>
            <button type="button" onClick={() => void control('stop')} disabled={!run || !running}>
              Stop
            </button>
          </div>
        </form>
        <p className="estimate muted" aria-live="polite">
          {estimate ? describeEstimate(estimate) : 'The estimate is not available yet.'}
        </p>
      </header>

      {health && !health.capture.isolated ? (
        <div className="notice" role="status">
          Source-code candidates run in the sandboxed artwork page: a separate origin, no credentials, no network, and no host
          directory access. A container boundary is stronger and is not configured.
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

      <main className="main">
        <section className="tree" aria-label="Version tree">
          {narrow ? (
            <GenerationList nodes={nodes} selected={selected} onSelect={setSelected} />
          ) : (
            <TreeView nodes={nodes} edges={tree?.edges ?? []} selected={selected} onSelect={setSelected} onOpen={setViewerVersion} onPlay={setPlaying} />
          )}
        </section>
        <aside className="panel" aria-label="Version detail">
          <DetailPanel version={selectedNode} onOpenViewer={setViewerVersion} onPlay={(id) => setPlaying(id)} active={Boolean(running)} />
        </aside>
      </main>

      <ProgressStrip run={run} stream={stream.events} connected={stream.connected} health={health} />

      {viewerVersion ? <CaptureViewer version={viewerVersion} onClose={() => setViewerVersion(null)} /> : null}

      {playing ? (
        <div className="live-overlay" role="dialog" aria-modal="true" aria-label="Live artwork">
          <div className="live-frame">
            <header>
              <span>Live artwork — {playingNode?.title ?? playing}</span>
              <button type="button" onClick={() => setPlaying(null)}>
                Close
              </button>
            </header>
            <iframe
              src={playingNode?.liveUrl ?? `/live/${playing}`}
              title={`Live artwork ${playingNode?.title ?? playing}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function describeEstimate(estimate: CostEstimate): string {
  const dollars = estimate.estimateUsd === null ? 'unknown' : `${estimate.estimateUsd.toFixed(3)} USD`;
  const tokens = estimate.tokens
    ? `, about ${Math.round(estimate.tokens.totalInput / 1000)}k input and ${Math.round(estimate.tokens.totalOutput / 1000)}k output tokens`
    : '';
  return (
    `${estimate.evolutions} evolution(s): ${estimate.authorCalls} author and ${estimate.judgeCalls} judge calls${tokens}. ` +
    `Estimate ${dollars}; the run reserves ${estimate.boundUsd.toFixed(3)} USD (${estimate.safetyFactor}× safety). ` +
    `${estimate.note}`
  );
}

function ProgressStrip({
  run,
  stream,
  connected,
  health,
}: {
  run: RunDetail | null;
  stream: { type: string; seq: number; payload: Record<string, unknown> }[];
  connected: boolean;
  health: Health | null;
}) {
  const last = stream.slice(-1)[0];
  const jobs = run?.jobs ?? [];
  const counts = jobs.reduce<Record<string, number>>((totals, job) => {
    totals[`${job.kind}:${job.state}`] = (totals[`${job.kind}:${job.state}`] ?? 0) + 1;
    return totals;
  }, {});
  const lastError = stream
    .filter((event) => event.type === 'error')
    .slice(-1)[0];

  return (
    <footer className="strip">
      <span className="pill">
        provider <strong>{health?.provider.driver ?? '—'}</strong>
        {health?.provider.substituted ? ' (test double)' : ''}
      </span>
      <span className="pill">
        capture <strong>{health?.capture.backend ?? '—'}</strong>
        {health?.capture.isolated ? ' (isolated)' : ' (sandboxed page)'}
      </span>
      <span className="pill">
        stream <strong>{connected ? 'live' : 'idle'}</strong> · seq {last?.seq ?? 0}
      </span>
      {run ? (
        <>
          <span className="pill">
            run <strong>{run.run.state}</strong> · rounds {run.run.evolutionsDone}/{run.run.evolutionsRequested}
          </span>
          <span className="pill">
            spend <strong>{run.run.spentUsd.toFixed(4)}</strong> of {run.run.limitUsd.toFixed(2)} USD
          </span>
          <span className="pill">calls {run.run.calls}</span>
          <span className="pill muted">
            {Object.entries(counts)
              .map(([key, value]) => `${key} ${value}`)
              .join(' · ')}
          </span>
          {lastError ? (
            <span className="pill warn">
              {String(lastError.payload.code ?? 'error')}: {String(lastError.payload.message ?? '')}
            </span>
          ) : null}
        </>
      ) : (
        <span className="pill muted">no run started in this session</span>
      )}
    </footer>
  );
}

function describe(cause: unknown): { code: string; message: string } {
  if (cause instanceof RequestError) return { code: cause.code, message: cause.message };
  if (cause instanceof Error) return { code: 'failed', message: cause.message };
  return { code: 'failed', message: String(cause) };
}

