// ─────────────────────────────────────────────────────────────────────────────
// fake.mjs — a deterministic test double for the model provider.
//
// It behaves like a real author session: it edits files in the workspace. It
// costs nothing and it needs no network, so the whole pipeline can be tested
// and demonstrated without a model.
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

const SLOTS = ['refinement', 'structure', 'experiment'];

export class FakeProvider {
  constructor({ config, logger = () => {} }) {
    this.config = config;
    this.logger = logger;
  }

  /** The test double needs no provider, so its catalog always answers. */
  async probe() {
    return { ok: true, status: 200, detail: 'the deterministic test double' };
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
  async author({ workspaceDir, round = 1, seedKey = 'seed', onEvent = null }) {
    // The test double reports the same event shape as the real driver, so the
    // interface feed works without a paid session.
    let callSeq = 0;
    const report = (toolName, args) => {
      if (!onEvent) return;
      const toolCallId = `${toolName}_${callSeq++}`;
      onEvent({ type: 'tool_execution_start', toolCallId, toolName, args });
      onEvent({ type: 'tool_execution_end', toolCallId, toolName, isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    };
    const slot = SLOTS[(Math.max(1, round) - 1) % SLOTS.length];
    const random = rngFrom(`${seedKey}|${round}|${slot}`);
    const configPath = join(workspaceDir, 'config.json');
    const configuration = JSON.parse(await readFile(configPath, 'utf8'));
    const notes = [];

    const scaleBy = (key, factor, decimals = 3) => {
      const before = configuration[key];
      const value = Number((before * factor).toFixed(decimals));
      configuration[key] = value;
      notes.push(`${key} ${before} → ${value}`);
    };

    if (slot === 'refinement') {
      scaleBy('num', 1 + (random() * 0.2 - 0.05));
      if (random() < 0.6) scaleBy('sensorDist', 1 + (random() * 0.3 - 0.12));
      if (random() < 0.4) scaleBy('decay', 1 + (random() * 0.4 - 0.15));
    } else if (slot === 'structure') {
      scaleBy('num', 0.5 + random());
      scaleBy('sensorAngle', 0.4 + random() * 1.6);
      scaleBy('rotAngle', 0.4 + random() * 1.6);
      if (random() < 0.5) scaleBy('spawnRadius', 0.5 + random() * 1.5);
    } else {
      scaleBy('scale', random() < 0.5 ? 0.5 : 1);
      scaleBy('gain', 0.5 + random() * 1.5);
    }

    configuration.num = Math.max(100, Math.min(200000, Math.round(configuration.num)));
    configuration.gamma = Math.max(0.05, Math.min(8, configuration.gamma));
    configuration.dpr = 1;

    const configBefore = await readFile(configPath, 'utf8');
    const configAfter = `${JSON.stringify(configuration, null, 2)}\n`;
    await writeFile(configPath, configAfter, 'utf8');
    report('edit', { path: configPath, edits: [minimalEdit(configBefore, configAfter)] });

    let sourceNote = '';
    const applied = await applySourceRecipe({ workspaceDir, slot });
    if (applied) {
      sourceNote = `\nChanged ${applied.file}: ${applied.note}`;
      report('edit', { path: join(workspaceDir, applied.file), edits: [minimalEdit(applied.before, applied.after)] });
    } else {
      sourceNote = '\nNo source recipe matched, so this step changes parameters only.';
    }

    const text = [
      `${FAKE_MARKER}: ${slot} change for step ${round}.`,
      `Parameters changed: ${notes.join(', ') || 'none'}.${sourceNote}`,
      'This answer comes from the deterministic test double, not from a model.',
      'Files changed: config.json' + (applied ? `, ${applied.file}` : ''),
    ].join('\n');

    // Report the same event shapes as the real driver, so the interface feed
    // shows a reasoning row and a text row without a paid session.
    if (onEvent) {
      onEvent({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: `The parent is at generation ${round - 1}. A ${slot} change moves the network without breaking the seeded stream.` }] } });
      onEvent({ type: 'message_update', delta: text });
      onEvent({ type: 'turn_end', usage: { totalTokens: 960, cost: { total: 0 } } });
    }

    return {
      text,
      usage: { inputTokens: 800, outputTokens: 160, costUsd: 0, raw: { stub: true }, costKnown: true },
      model: 'fake-deterministic',
      sessionId: `fake-${seedKey}-${round}-${slot}`,
      stub: true,
    };
  }
}
