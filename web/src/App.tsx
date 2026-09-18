import { useCallback, useEffect, useMemo, useState } from 'react';

import { RequestError, api, useRunEvents } from './api';
import type {
  AgentRow,
  CostEstimate,
  Decision,
  FileRow,
  Health,
  Measure,
  ModelList,
  RecordingStatus,
  RelationshipsView,
  RunDetail,
  Tree,
} from './types';
import { TreeView } from './components/TreeView';
import { GenerationList } from './components/GenerationList';
import { DetailPanel } from './components/DetailPanel';
import { RelationshipsPanel } from './components/RelationshipsPanel';
import { CaptureViewer } from './components/CaptureViewer';

// A build stamp shows in the strip, so a stale tab is easy to spot.
const BUILD_STAMP = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

const DEFAULT_DIRECTION = 'quieter, more directional, fewer crossings, light background';

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [artworkId, setArtworkId] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [hideFailed, setHideFailed] = useState(false);
  const [record, setRecord] = useState(false);
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
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

  // The relationship layer. It is independent of the run and of the rings.
  const [panel, setPanel] = useState<'detail' | 'relationships'>('detail');
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [measureId, setMeasureId] = useState('configuration');
  const [relationships, setRelationships] = useState<RelationshipsView | null>(null);
  const [relationshipsError, setRelationshipsError] = useState<string | null>(null);
  const [relationshipsBusy, setRelationshipsBusy] = useState(false);
  const [threshold, setThreshold] = useState(0);
  const [hideAncestorPairs, setHideAncestorPairs] = useState(false);
  const [showRelationshipLines, setShowRelationshipLines] = useState(true);
  const [selectedPairKey, setSelectedPairKey] = useState<string | null>(null);

  const stream = useRunEvents(runId);

  // The agent feed, the newest frame of each version, and the decisions, all
  // derived from the event stream so one source drives every animation.
  const agentRows = useMemo(
    () => stream.events.filter((event) => event.type === 'agent').map((event) => ({ seq: event.seq, ...(event.payload as unknown as Omit<AgentRow, 'seq'>) })),
    [stream.events],
  );
  const fileRows = useMemo(
    () => stream.events.filter((event) => event.type === 'file').map((event) => ({ seq: event.seq, ...(event.payload as unknown as Omit<FileRow, 'seq'>) })),
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
      const saved = JSON.parse(raw) as { selected?: string | null; variants?: number; evolutions?: number; direction?: string; hideFailed?: boolean; record?: boolean };
      if (saved.selected) setSelected(saved.selected);
      if (typeof saved.variants === 'number') setVariants(saved.variants);
      if (typeof saved.evolutions === 'number') setEvolutions(saved.evolutions);
      if (typeof saved.direction === 'string' && saved.direction.length > 0) setDirection(saved.direction);
      if (typeof saved.hideFailed === 'boolean') setHideFailed(saved.hideFailed);
      if (typeof saved.record === 'boolean') setRecord(saved.record);
    } catch {
      // a broken entry must not stop the page
    }
  }, [artworkId]);

  useEffect(() => {
    if (!artworkId) return;
    try {
      window.localStorage.setItem(
        `phygen.view.${artworkId}`,
        JSON.stringify({ selected, variants, evolutions, direction, hideFailed, record }),
      );
    } catch {
      // storage may be unavailable; the page still works
    }
  }, [artworkId, selected, variants, evolutions, direction, hideFailed, record]);

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
        record,
      });
      setRun(await api.run(created.run.id));
      if (artworkId) await loadTree(artworkId);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleRecording = async (enabled: boolean) => {
    setRecord(enabled);
    if (!runId) return;
    try {
      const result = await api.setRecording(runId, enabled);
      setRecording(result.recording);
    } catch (cause) {
      setError(describe(cause));
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
  /**
   * The settings describe the NEXT run, so only a run that is actually working
   * locks them. A paused run used to lock every field, which made the whole
   * header look dead: a person could not even change a model.
   */
  const settingLocked = run ? ['queued', 'running', 'stopping'].includes(run.run.state) : false;
  const allNodes = tree?.nodes ?? [];
  const failedCount = allNodes.filter((node) => node.status === 'failed').length;
  const artworkRootId = tree?.artwork.rootVersionId ?? null;
  const nodes = useMemo(() => {
    if (!hideFailed) return allNodes;
    const kept = allNodes.filter((node) => node.status !== 'failed');
    // The original root stays on the canvas: a filter must not delete the
    // centre that every ring is measured from.
    const root = allNodes.find((node) => node.id === artworkRootId);
    return root && !kept.some((node) => node.id === root.id) ? [root, ...kept] : kept;
  }, [allNodes, hideFailed, artworkRootId]);
  const visibleIds = useMemo(() => new Set(nodes.map((node) => node.id)), [nodes]);
  // A hidden version must not leave a dangling connection behind.
  const edges = useMemo(
    () => (tree?.edges ?? []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [tree, visibleIds],
  );
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selected) ?? null, [nodes, selected]);

  // ── the relationship layer ────────────────────────────────────────────────
  // The measure catalog is loaded once. A measurement is loaded per artwork and
  // measure, and polled only while it is running.
  useEffect(() => {
    void api
      .measures()
      .then((list) => {
        setMeasures(list.measures);
        if (list.defaultMeasure) setMeasureId((current) => (list.measures.some((m) => m.id === current && m.available) ? current : list.defaultMeasure as string));
      })
      .catch(() => setMeasures([]));
  }, []);

  const analysisRunning = relationships?.run ? ['queued', 'running'].includes(relationships.run.state) : false;
  useEffect(() => {
    if (!artworkId) return undefined;
    let cancelled = false;
    const load = () => {
      api
        .relationships(artworkId, measureId)
        .then((view) => {
          if (cancelled) return;
          setRelationships(view);
          setRelationshipsError(null);
        })
        .catch((cause) => {
          if (!cancelled) setRelationshipsError(describe(cause).message);
        });
    };
    load();
    if (!analysisRunning) return () => { cancelled = true; };
    const timer = window.setInterval(load, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [artworkId, measureId, analysisRunning]);

  const rebuildRelationships = useCallback(async () => {
    if (!artworkId) return;
    setRelationshipsBusy(true);
    setRelationshipsError(null);
    try {
      await api.rebuildRelationships(artworkId, measureId);
      setRelationships(await api.relationships(artworkId, measureId));
    } catch (cause) {
      setRelationshipsError(describe(cause).message);
    } finally {
      setRelationshipsBusy(false);
    }
  }, [artworkId, measureId]);

  const cancelAnalysis = useCallback(async () => {
    if (!relationships?.run) return;
    try {
      await api.cancelAnalysis(relationships.run.id);
    } catch (cause) {
      setRelationshipsError(describe(cause).message);
    }
  }, [relationships]);

  /**
   * The secondary draw layer. A pair that passes the filter becomes one dashed
   * line between the two cards. The score decides the dash, never the ring.
   */
  const relationshipDraws = useMemo(() => {
    if (!showRelationshipLines) return [];
    const pairs = relationships?.pairs ?? [];
    const nodeIds = new Set(allNodes.map((node) => node.id));
    const seen = new Set<string>();
    const draws: { id: string; source: string; target: string; pairKey: string; score: number; band: string | null; group: string | null; ancestor: boolean }[] = [];
    for (const pair of pairs) {
      if (pair.outcome !== 'ok') continue;
      if (!nodeIds.has(pair.a) || !nodeIds.has(pair.b)) continue;
      if (hideAncestorPairs && pair.ancestor) continue;
      if ((pair.score ?? 0) < threshold) continue;
      // A lineage pair already has a solid ancestry line: do not draw it twice.
      if (pair.ancestor) continue;
      if (seen.has(pair.pairKey)) continue;
      seen.add(pair.pairKey);
      draws.push({ id: `rel_${pair.id}`, source: pair.a, target: pair.b, pairKey: pair.pairKey, score: pair.score ?? 0, band: pair.band, group: pair.group, ancestor: pair.ancestor });
    }
    return draws;
  }, [relationships, showRelationshipLines, hideAncestorPairs, threshold, allNodes]);
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

  // The recording status, while a documentation run is going.
  useEffect(() => {
    if (!running && !recording?.active) return undefined;
    const load = () => {
      void api
        .recording()
        .then(setRecording)
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [running, recording?.active]);



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
              disabled={settingLocked}
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
              disabled={settingLocked}
            />
          </label>
          <label className="field">
            <span>Judge model</span>
            <select value={judgeModel} onChange={(event) => setJudgeModel(event.target.value)} disabled={settingLocked}>
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
            <select value={authorModel} onChange={(event) => setAuthorModel(event.target.value)} disabled={settingLocked}>
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
              disabled={settingLocked}
            />
          </label>
          <div className="bar-actions">
            <button
              type="submit"
              className="primary"
              disabled={running || busy || !tree}
              title={
                running
                  ? `A run is ${run?.run.state ?? 'active'}. Resume or stop it before you start another.`
                  : 'Start a run from the selected version.'
              }
            >
              Start
            </button>
            <button type="button" onClick={() => void control('pause')} disabled={!run || run.run.state !== 'running'} title="Stop new work after the current step.">
              Pause
            </button>
            <button type="button" onClick={() => void control('resume')} disabled={!run || run.run.state !== 'paused'} title="Continue the paused run from what it already published.">
              Resume
            </button>
            <button type="button" onClick={() => void control('stop')} disabled={!run || !running} title="End the run. The work already published stays.">
              Stop
            </button>
          </div>
        </form>
        {run ? (
          <p className={`run-state run-state-${run.run.state}`} role="status">
            <strong>This run is {run.run.state}.</strong>{' '}
            {run.run.state === 'paused'
              ? 'The settings below apply to the next run. Resume this one to continue it, or stop it to finish it.'
              : 'The settings below apply to the next run.'}
          </p>
        ) : null}
        <p className="branch-row muted">
          selected version spawns the variants:
          <span className="branch-chip">{parentNode ? parentNode.title : 'the root version'}</span>
          {parentNode ? (
            <span className="muted">
              palette <strong>{parentNode.palette ?? 'unknown'}</strong> · the variants inherit it
            </span>
          ) : null}
          <label className="follow-toggle">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> follow the active node
          </label>
          <label className="follow-toggle" title="Save one PNG per second of the whole interface, then encode a lossless video">
            <input type="checkbox" checked={record} onChange={(event) => void toggleRecording(event.target.checked)} /> document this run
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

      {health?.provider.substituted ? (
        <div className="notice notice-alert" role="alert">
          <strong>The provider is a TEST DOUBLE.</strong> The agents are a deterministic stub: they ignore the direction, and their
          verdicts are not evidence. Every comparison from these runs is marked <code>stub</code>. To run the real agents, start the
          server with <code>PHYGEN_DRIVER=pi</code> and <code>PHYGEN_ALLOW_SPEND=1</code>.
        </div>
      ) : null}

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
              allNodes={allNodes}
              rootId={artworkRootId}
              relationships={relationshipDraws}
              edges={edges}
              selected={selected}
              activeVersionIds={activeVersionIds}
              activeKinds={activeKinds}
              liveFrames={liveFrames}
              decisions={freshDecisions}
              agentRows={agentRows}
              fileRows={fileRows}
              follow={follow}
              onSelect={selectNode}
              onOpen={setViewerVersion}
              onPlay={setPlaying}
            />
          )}
        </section>
        <aside className="panel" aria-label="Version detail">
          <div className="tabs" role="tablist" aria-label="Panel">
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'detail'}
              className={panel === 'detail' ? 'is-current' : ''}
              onClick={() => setPanel('detail')}
            >
              Detail
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panel === 'relationships'}
              className={panel === 'relationships' ? 'is-current' : ''}
              onClick={() => setPanel('relationships')}
            >
              Relationships
              {relationships?.run && ['queued', 'running'].includes(relationships.run.state) ? ' …' : ''}
            </button>
          </div>
          {panel === 'detail' ? (
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
          ) : (
            <RelationshipsPanel
              measures={measures}
              measureId={measureId}
              onMeasure={setMeasureId}
              view={relationships}
              loading={relationshipsBusy}
              error={relationshipsError}
              onRebuild={() => void rebuildRelationships()}
              onCancel={() => void cancelAnalysis()}
              threshold={threshold}
              onThreshold={setThreshold}
              hideAncestorPairs={hideAncestorPairs}
              onHideAncestorPairs={setHideAncestorPairs}
              showLines={showRelationshipLines}
              onShowLines={setShowRelationshipLines}
              selectedPairKey={selectedPairKey}
              onSelectPair={setSelectedPairKey}
              nodes={nodes}
              onSelectVersion={selectNode}
              onOpenVersion={setViewerVersion}
            />
          )}
        </aside>
      </main>

      <ProgressStrip run={run} stream={stream.events} connected={stream.connected} health={health} recording={recording} />

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
  recording,
}: {
  run: RunDetail | null;
  stream: { type: string; seq: number; payload: Record<string, unknown> }[];
  connected: boolean;
  health: Health | null;
  recording: RecordingStatus | null;
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
          {recording?.active ? (
            <span className="pill warn">
              recording <strong>{recording.frames}</strong> frame(s)
            </span>
          ) : null}
          {recording && !recording.active && recording.video ? (
            <span className="pill muted">video {recording.video.split(/[\\/]/).pop()}</span>
          ) : null}
          {recording?.error ? <span className="pill warn">{recording.error}</span> : null}
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

