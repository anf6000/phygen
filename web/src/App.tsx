import { useCallback, useEffect, useMemo, useState } from 'react';

import { RequestError, api, useRunEvents } from './api';
import type { AgentRow, CostEstimate, Decision, Health, ModelList, RunDetail, Tree } from './types';
import { TreeView } from './components/TreeView';
import { GenerationList } from './components/GenerationList';
import { DetailPanel } from './components/DetailPanel';
import { CaptureViewer } from './components/CaptureViewer';

// The build stamp shows in the strip, so a stale tab is easy to spot.
const BUILD_STAMP = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

const DEFAULT_DIRECTION = 'quieter, more directional, fewer crossings, light background';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [artworkId, setArtworkId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [hideFailed, setHideFailed] = useState(false);
  const [viewerVersion, setViewerVersion] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [direction, setDirection] = useState(DEFAULT_DIRECTION);
  const [evolutions, setEvolutions] = useState(1);
  const [variants, setVariants] = useState(3);
  const [models, setModels] = useState<ModelList | null>(null);
  const [judgeModel, setJudgeModel] = useState('');
  const [authorModel, setAuthorModel] = useState('');
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const runId = run?.run.id ?? null;

  const stream = useRunEvents(runId);

  // The agent feed, the newest frame of each version, and the decisions, all
  // derived from the event stream so one source drives every animation.
  const agentRows = useMemo(
    () => stream.events.filter((event) => event.type === 'agent').map((event) => ({ seq: event.seq, ...(event.payload as unknown as Omit<AgentRow, 'seq'>) })),
    [stream.events],
  );
  const liveFrames = useMemo(() => {
    const frames: Record<string, { url: string; stage: string; step: number }> = {};
    for (const event of stream.events) {
      if (event.type !== 'capture.ready') continue;
      const payload = event.payload as { versionId?: string; url?: string; stage?: string; step?: number };
      if (!payload.versionId || !payload.url) continue;
      frames[payload.versionId] = { url: payload.url, stage: payload.stage ?? '', step: payload.step ?? 0 };
    }
    return frames;
  }, [stream.events]);
  const decisions = useMemo(() => {
    const found: Record<string, Decision & { at: number }> = {};
    for (const event of stream.events) {
      if (event.type !== 'version.decision') continue;
      const payload = event.payload as unknown as Decision;
      if (!payload.versionId) continue;
      found[payload.versionId] = { ...payload, at: Date.parse(event.at) || Date.now() };
    }
    return found;
  }, [stream.events]);

  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 400);
    return () => window.clearInterval(timer);
  }, []);
  // A decision shows for a few seconds, then the tree goes quiet again.
  const freshDecisions = useMemo(() => {
    const shown: Record<string, Decision> = {};
    for (const [versionId, decision] of Object.entries(decisions)) {
      if (clock - decision.at < 6000) shown[versionId] = decision;
    }
    return shown;
  }, [decisions, clock]);

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

  // Remember the selection and the run settings for this artwork, so a refresh
  // returns to the same version.
  useEffect(() => {
    if (!artworkId) return;
    try {
      const raw = window.localStorage.getItem(`phygen.view.${artworkId}`);
      if (!raw) return;
      const saved = JSON.parse(raw) as { selected?: string | null; variants?: number; evolutions?: number; direction?: string; hideFailed?: boolean };
      if (saved.selected) setSelected(saved.selected);
      if (typeof saved.variants === 'number') setVariants(saved.variants);
      if (typeof saved.evolutions === 'number') setEvolutions(saved.evolutions);
      if (typeof saved.direction === 'string' && saved.direction.length > 0) setDirection(saved.direction);
      if (typeof saved.hideFailed === 'boolean') setHideFailed(saved.hideFailed);
    } catch {
      // a broken entry must not stop the page
    }
  }, [artworkId]);

  useEffect(() => {
    if (!artworkId) return;
    try {
      window.localStorage.setItem(
        `phygen.view.${artworkId}`,
        JSON.stringify({ selected, variants, evolutions, direction, hideFailed }),
      );
    } catch {
      // storage may be unavailable; the page still works
    }
  }, [artworkId, selected, variants, evolutions, direction, hideFailed]);

  // A stored id can point at a version that no longer exists.
  useEffect(() => {
    if (!tree || !selected) return;
    if (!tree.nodes.some((node) => node.id === selected)) setSelected(tree.artwork.rootVersionId);
  }, [tree, selected]);

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
      .estimate(evolutions, judgeModel || undefined, authorModel || undefined, variants)
      .then(setEstimate)
      .catch(() => setEstimate(null));
  }, [evolutions, judgeModel, authorModel, variants]);

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
        // The selected version is the parent of the new variants.
        branchFromVersionId: parentVersionId ?? undefined,
        direction,
        evolutions,
        variants,
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
  const allNodes = tree?.nodes ?? [];
  const failedCount = allNodes.filter((node) => node.status === 'failed').length;
  const nodes = useMemo(() => (hideFailed ? allNodes.filter((node) => node.status !== 'failed') : allNodes), [allNodes, hideFailed]);
  const visibleIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  // A hidden version must not leave a dangling connection behind.
  const edges = useMemo(
    () => (tree?.edges ?? []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [tree, visibleIds],
  );
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selected) ?? null, [nodes, selected]);
  // The selected version spawns the children. There is no second step.
  const parentVersionId = selected ?? tree?.artwork.rootVersionId ?? null;
  const parentNode = useMemo(() => nodes.find((node) => node.id === parentVersionId) ?? null, [nodes, parentVersionId]);
  const activeVersionIds = tree?.activeVersionIds ?? [];
  const activeKinds = tree?.activeKinds ?? {};
  const playingNode = useMemo(() => nodes.find((node) => node.id === playing) ?? null, [nodes, playing]);
  const visionModels = models?.models.filter((model) => model.acceptsImages) ?? [];

  // The feed follows the work: while a version is being made, that version's
  // session is shown even when another version is selected.
  const workedVersion = useMemo(() => nodes.find((node) => node.id === activeVersionIds[0]) ?? null, [nodes, activeVersionIds]);
  const feedVersion = workedVersion ?? selectedNode;
  const feedRows = useMemo(
    () => agentRows.filter((row) => row.versionId === feedVersion?.id),
    [agentRows, feedVersion],
  );

  /** Selecting a version also aims the next run at it. */
  const selectNode = useCallback((id: string) => setSelected(id), []);

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
            <span>Evolutions (levels)</span>
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
            <span>Variants per evolution</span>
            <input
              type="number"
              min={1}
              max={8}
              value={variants}
              onChange={(event) => setVariants(Math.max(1, Math.min(8, Number(event.target.value) || 1)))}
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
        <p className="branch-row muted">
          selected version spawns the variants:
          <span className="branch-chip">{parentNode ? parentNode.title : 'the root version'}</span>
          <label className="follow-toggle">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> follow the active node
          </label>
          <label className="follow-toggle">
            <input
              type="checkbox"
              checked={hideFailed}
              onChange={(event) => setHideFailed(event.target.checked)}
              disabled={failedCount === 0}
            />
            hide failed{failedCount > 0 ? ` (${failedCount})` : ''}
          </label>
        </p>
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
            <GenerationList nodes={nodes} selected={selected} activeVersionIds={activeVersionIds} onSelect={selectNode} />
          ) : (
            <TreeView
              nodes={nodes}
              edges={edges}
              selected={selected}
              activeVersionIds={activeVersionIds}
              activeKinds={activeKinds}
              liveFrames={liveFrames}
              decisions={freshDecisions}
              follow={follow}
              onSelect={selectNode}
              onOpen={setViewerVersion}
              onPlay={setPlaying}
            />
          )}
        </section>
        <aside className="panel" aria-label="Version detail">
          <DetailPanel
            version={selectedNode}
            onOpenViewer={setViewerVersion}
            onPlay={(id) => setPlaying(id)}
            isParent={parentVersionId === selectedNode?.id}
            agentRows={feedRows}
            agentFor={workedVersion && workedVersion.id !== selectedNode?.id ? workedVersion.title : null}
            agentActive={Boolean(workedVersion)}
            active={Boolean(running)}
          />
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
  const perLevel = estimate.variants ?? estimate.candidatesPerRound;
  return (
    `${estimate.evolutions} evolution(s) of ${perLevel} variant(s): ${estimate.authorCalls} author and ${estimate.judgeCalls} judge calls${tokens}. ` +
    `Expected cost about ${dollars}. No cost limit is enforced; the record keeps the real cost.`
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
  const perLevel = run?.run.protocol?.variantsPerEvolution ?? null;
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
            run <strong>{run.run.state}</strong> · evolutions {run.run.evolutionsDone}/{run.run.evolutionsRequested}
            {perLevel ? <> · <strong>{perLevel}</strong> variants each</> : null}
          </span>
          <span className="pill">
            spent <strong>{run.run.spentUsd.toFixed(4)}</strong> USD
          </span>
          <span className="pill">calls {run.run.calls}</span>
          <span className="pill muted">
            {Object.entries(counts)
              .map(([key, value]) => `${key} ${value}`)
              .join(' · ')}
          </span>
          <span className="pill muted">ui {BUILD_STAMP}</span>
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

