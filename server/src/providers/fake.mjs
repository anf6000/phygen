// ─────────────────────────────────────────────────────────────────────────────
// fake.mjs — a deterministic test double for the model provider.
//
// It behaves like a real session: it edits files in the workspace, and it
// answers a judge request with structured JSON. It costs nothing and it needs
// no network, so the whole pipeline can be tested and demonstrated.
//
// It is NOT a vision model. Every answer it gives is marked as a stub, and a
// comparison that used it can never be presented as visual judgment.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { minimalEdit } from '../controller/agent-events.mjs';
import { applySourceRecipe } from './fake-edits.mjs';

export const FAKE_MARKER = 'stub-test-double';

/** mulberry32, so the same inputs always give the same candidate. */
function rngFrom(seedText) {
  let state = 0x811c9dc5;
  for (let index = 0; index < seedText.length; index++) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, options) {
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))];
}

const PALETTES = ['white', 'bone', 'ice', 'ember', 'viridis', 'inferno', 'magma'];

export class FakeProvider {
  constructor({ config, logger = () => {} }) {
    this.config = config;
    this.logger = logger;
  }

  async detect() {
    return {
      driver: 'fake',
      available: true,
      version: FAKE_MARKER,
      provider: 'fake',
      model: 'fake-deterministic',
      credentialsPresent: false,
      allowSpend: this.config.provider.allowSpend,
    };
  }

  /**
   * Edit the candidate workspace the way an author session would.
   * The controller reads the result from the files, never from this text.
   */
  async author({ workspaceDir, plan, direction, round, slot, parentConfig, seedKey, onEvent = null }) {
    // The test double reports the same event shape as the real driver, so the
    // interface feed works without a paid session.
    const report = (toolName, args) => {
      if (!onEvent) return;
      onEvent({ type: 'tool_execution_start', toolName, args });
      onEvent({ type: 'tool_execution_end', toolName, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    };
    const random = rngFrom(`${seedKey}|${round}|${slot}|${direction}|${plan?.kind ?? 'refinement'}`);
    const configPath = join(workspaceDir, 'config.json');
    const configuration = JSON.parse(await readFile(configPath, 'utf8'));
    const notes = [];

    const scaleBy = (key, factor, decimals = 3) => {
      const before = configuration[key];
      const value = Number((before * factor).toFixed(decimals));
      configuration[key] = value;
      notes.push(`${key} ${before} → ${value}`);
    };

    const kind = plan?.slot ?? 'refinement';
    if (kind === 'refinement') {
      scaleBy('num', 1 + (random() * 0.2 - 0.05));
      if (random() < 0.6) scaleBy('sensorDist', 1 + (random() * 0.3 - 0.12));
      if (random() < 0.4) scaleBy('decay', 1 + (random() * 0.4 - 0.15));
    } else if (kind === 'structure') {
      scaleBy('num', 0.5 + random());
      scaleBy('sensorAngle', 0.4 + random() * 1.6);
      scaleBy('rotAngle', 0.4 + random() * 1.6);
      if (random() < 0.5) scaleBy('spawnRadius', 0.5 + random() * 1.5);
    } else {
      configuration.palette = pick(random, PALETTES.filter((name) => name !== configuration.palette));
      scaleBy('scale', random() < 0.5 ? 0.5 : 1);
      scaleBy('gain', 0.5 + random() * 1.5);
      configuration.seed = Math.floor(random() * 4294967295);
      notes.push(`seed → ${configuration.seed}`);
    }

    configuration.num = Math.max(100, Math.min(200000, Math.round(configuration.num)));
    configuration.gamma = Math.max(0.05, Math.min(8, configuration.gamma));
    configuration.dpr = 1;

    const configBefore = await readFile(configPath, 'utf8');
    const configAfter = `${JSON.stringify(configuration, null, 2)}\n`;
    await writeFile(configPath, configAfter, 'utf8');
    report('edit', { path: configPath, edits: [minimalEdit(configBefore, configAfter)] });

    let sourceNote = '';
    const wantsSource = plan?.touchesSource !== false;
    if (wantsSource) {
      const applied = await applySourceRecipe({ workspaceDir, slot: kind });
      if (applied) {
        sourceNote = `\nChanged ${applied.file}: ${applied.note}`;
        report('edit', { path: join(workspaceDir, applied.file), edits: [minimalEdit(applied.before, applied.after)] });
      } else {
        sourceNote = '\nNo source recipe matched, so this candidate changes parameters only.';
      }
    }

    const text = [
      `${FAKE_MARKER}: ${kind} candidate for round ${round}, slot ${slot}.`,
      `Direction: ${direction}`,
      `Parameters changed: ${notes.join(', ') || 'none'}.${sourceNote}`,
      'This answer comes from the deterministic test double, not from a model.',
    ].join('\n');

    return {
      text,
      usage: { inputTokens: 800, outputTokens: 160, costUsd: 0, raw: { stub: true }, costKnown: true },
      model: 'fake-deterministic',
      sessionId: `fake-${seedKey}-${round}-${slot}`,
      stub: true,
    };
  }

  /**
   * Answer a judge request.
   *
   * The stub prefers the image that differs most from the reference image, so a
   * demonstration shows a moving lineage. It measures pixels, which is exactly
   * what the plan forbids for a real judgment, so the verdict is marked.
   */
  async judge({ prompt, images, stub = {}, signal }) {
    if (signal?.aborted) throw new Error('judge cancelled');
    const reference = images.find((image) => image.label === stub.referenceLabel) ?? images[0];
    const others = images.filter((image) => image.label !== reference.label);
    const referenceBytes = await readFile(reference.path);

    let best = null;
    for (const image of others) {
      const bytes = await readFile(image.path);
      const difference = fractionalDifference(referenceBytes, bytes);
      if (!best || difference > best.difference) best = { label: image.label, difference };
    }

    const verdict = {
      stub: FAKE_MARKER,
      observations: images.map((image) => ({
        label: image.label,
        frame: `${image.stage}@${image.step}`,
        detail: `Stub reading only: ${image.stage} frame at step ${image.step} of seed ${image.seed}.`,
      })),
      preference: best ? best.label : reference.label,
      weaknesses: ['A stub cannot see. Replace this judge with the vision model.'],
      uncertainty: 'high',
      confidence: best ? Number(Math.min(0.99, 0.5 + best.difference * 2).toFixed(3)) : 0,
      distinctiveness: others.length > 1 ? 'medium' : 'low',
      notes: 'Deterministic test double. Never use this verdict as aesthetic evidence.',
    };

    return {
      text: `\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\``,
      usage: { inputTokens: 2200, outputTokens: 320, costUsd: 0, raw: { stub: true }, costKnown: true },
      model: 'fake-deterministic',
      sessionId: `fake-judge-${images.map((image) => image.label).join('')}-${referenceBytes.length}`,
      stub: true,
    };
  }
}

/** A cheap, deterministic difference measure between two PNG buffers. */
export function fractionalDifference(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let different = 0;
  const step = Math.max(1, Math.floor(length / 20000));
  let sampled = 0;
  for (let index = 0; index < length; index += step) {
    sampled++;
    if (a[index] !== b[index]) different++;
  }
  const sizePenalty = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
  return different / sampled + sizePenalty * 0.1;
}

