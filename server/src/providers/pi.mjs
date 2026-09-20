// ─────────────────────────────────────────────────────────────────────────────
// pi.mjs — the Pi session driver.
//
// Every model request runs one `pi` process in JSON event mode:
//
//   pi --mode json -p --provider kilo --model <model> [--tools …] [@image…] <prompt>
//
// The provider is the official Kilo provider extension. An evolve session gets
// file tools and the attached frames, so it can see the chain it evolves.
//
// The driver never decides when to spend. The controller reserves the cost
// bound first, and the driver refuses to start unless the operator enabled
// spending.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtworkError } from '../../../runtime/contract.js';
import { truncate, unique } from '../util.mjs';

export class ProviderError extends ArtworkError {
  constructor(code, message, details) {
    super(code, message, details);
    this.name = 'ProviderError';
  }
}

const WORKSPACE_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL', 'ComSpec', 'PATHEXT',
];

/** A child process with no credentials, and no server secrets, in its environment. */
function safeEnv() {
  const env = {};
  for (const key of WORKSPACE_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Pi stores its own credentials outside the environment, in the user profile.
  env.PI_NO_UPDATE_CHECK = '1';
  env.NO_COLOR = '1';
  return env;
}

async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  child.kill('SIGKILL');
}

function normalizeUsage(raw) {
  const usage = raw && typeof raw === 'object' ? raw : {};
  const inputTokens = Number(usage.inputTokens ?? usage.input ?? usage.promptTokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output ?? usage.completionTokens ?? 0) || 0;
  const cost = usage.cost;
  const costUsd =
    typeof cost === 'number'
      ? cost
      : Number(cost?.total ?? usage.costUsd ?? usage.totalCostUsd ?? 0) || 0;
  return { inputTokens, outputTokens, costUsd, costKnown: costUsd > 0, raw: usage };
}

const REASONING_TYPES = new Set(['reasoning', 'thinking', 'redacted_thinking']);

/** The reasoning text of one content block, or '' when it holds none. */
function reasoningTextOf(block) {
  const candidate = block?.text ?? block?.thinking ?? block?.content;
  return typeof candidate === 'string' ? candidate : '';
}

/**
 * Read one message. The answer text and the reasoning content stay separate:
 * the shell shows reasoning dim, and the record keeps only the answer.
 */
function contentFromMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return { text: content, reasoning: '' };
  if (!Array.isArray(content)) return { text: '', reasoning: '' };
  let text = '';
  let reasoning = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'reasoning' || block.type === 'thinking' || block.type === 'redacted_thinking') {
      reasoning += reasoningTextOf(block);
    } else if (block.type === 'text' || block.type === 'output_text') {
      text += block.text ?? '';
    }
  }
  return { text, reasoning };
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class PiProvider {
  constructor({ config, logger = () => {} }) {
    this.config = config;
    this.logger = logger;
    this.detected = null;
  }

  /**
   * How to start Pi. A Windows shim is a .cmd file, which a child process
   * cannot start without a shell, so run the CLI entry with the same node.
   */
  #spawnSpec() {
    const entry = this.config.provider.entry;
    if (entry) return { command: process.execPath, prefix: [entry] };
    return { command: this.config.provider.command, prefix: [] };
  }

  /**
   * Check that the provider catalog answers. The extension fetches its model
   * list as the session starts and keeps it in memory only, so a failed fetch
   * there leaves no provider at all. This check costs nothing.
   */
  async probe({ attempts = 3, timeoutMs = 30000 } = {}) {
    const url = `${String(this.config.models?.baseUrl ?? 'https://api.kilo.ai').replace(/\/$/, '')}/api/gateway/models`;
    let last = { ok: false, status: 0, detail: 'not tried' };
    // The gateway stalls now and then: a request can hang with no answer while
    // the next one is immediate. Try again before calling it unavailable.
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url, { headers: { 'user-agent': 'phygen' }, signal: AbortSignal.timeout(timeoutMs) });
        if (response.ok) return { ok: true, status: response.status, detail: `${response.status} from ${url}`, attempt };
        last = { ok: false, status: response.status, detail: `${response.status} from ${url}`, attempt };
      } catch (error) {
        last = { ok: false, status: 0, detail: String(error?.message ?? error), attempt };
      }
      if (attempt < attempts) await sleepMs(1500 * attempt);
    }
    return last;
  }

  /** Check the command without spending anything. */
  async detect() {
    if (this.detected) return this.detected;
    const version = await this.#capture([ '--version' ], { timeoutMs: 30000 });
    const credentials = await this.#credentialsPresent();
    this.detected = {
      driver: 'pi',
      available: version.code === 0,
      version: version.stdout.trim().split('\n')[0] || null,
      provider: this.config.provider.providerName,
      model: this.config.provider.model,
      credentialsPresent: credentials,
      allowSpend: this.config.provider.allowSpend,
    };
    return this.detected;
  }

  async #credentialsPresent() {
    try {
      const auth = JSON.parse(await readFile(join(process.env.USERPROFILE || process.env.HOME || '.', '.pi', 'agent', 'auth.json'), 'utf8'));
      return Object.keys(auth ?? {}).length > 0;
    } catch {
      return false;
    }
  }

  #capture(args, { timeoutMs }) {
    return new Promise((resolve) => {
      const spec = this.#spawnSpec();
      const child = spawn(spec.command, [...spec.prefix, ...args], { env: safeEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        void killTree(child);
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  /**
   * Run one session.
   *
   * @param {object} options
   * @param {'author'} options.kind
   * @param {string} options.prompt
   * @param {string[]} [options.images] absolute image paths, attached with @
   * @param {string} options.cwd
   * @param {string} [options.sessionId]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{text: string, reasoning: string, sessionId: string|null, usage: object, events: object[], exitCode: number, stderr: string}>}
   */
  async run({ kind, prompt, images = [], cwd, sessionId, model, timeoutMs, signal, systemPrompt, onEvent = null }) {
    // A Stop before the request must not start a process at all.
    if (signal?.aborted) {
      throw new ProviderError('cancelled', 'The run stopped before the provider session started.', { kind });
    }
    if (!this.config.provider.allowSpend) {
      throw new ProviderError(
        'spend_not_allowed',
        'The provider is disabled. Set PHYGEN_ALLOW_SPEND=1 to permit real model calls.',
        { kind },
      );
    }
    for (const image of images) {
      try {
        await stat(image);
      } catch {
        throw new ProviderError('image_missing', `The attached frame does not exist: ${image}`, { image });
      }
    }

    const { providerName, thinking, authorThinking, authorTools } = this.config.provider;
    const args = ['--mode', 'json', '-p', '--provider', providerName, '--model', model ?? this.config.provider.authorModel];
    const effort = kind === 'author' ? authorThinking : thinking;
    if (effort) args.push('--thinking', effort);
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    if (kind === 'author') args.push('--tools', authorTools);
    else args.push('--no-tools');
    args.push('--no-approve');
    if (sessionId) args.push('--session-id', sessionId);
    args.push('--', ...images.map((image) => `@${image}`), prompt);

    const limit = timeoutMs ?? this.config.provider.sessionTimeoutMs;
    const spec = this.#spawnSpec();
    // stdin is closed at once: Pi must not wait for input that will never come.
    const child = spawn(spec.command, [...spec.prefix, ...args], { cwd, env: safeEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

    const events = [];
    let stdoutBuffer = '';
    let stderr = '';
    let cancelled = false;

    const onAbort = () => {
      cancelled = true;
      void killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      cancelled = true;
      void killTree(child);
    }, limit);

    const exitCode = await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsedLine = null;
          try {
            parsedLine = JSON.parse(trimmed);
          } catch {
            parsedLine = { type: 'raw', text: truncate(trimmed, 400) };
          }
          events.push(parsedLine);
          if (onEvent) {
            try {
              onEvent(parsedLine);
            } catch {
              // a broken listener must not stop the session
            }
          }
        }
      });
      let stderrLines = 0;
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        // Pi reports retries and provider problems on stderr. Keep them visible.
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          stderrLines++;
          if (stderrLines <= 40) this.logger('warn', `pi ${kind} ${sessionId ?? ''}: ${truncate(trimmed, 200)}`);
        }
      });
      child.on('error', (error) => {
        stderr += `\n${error.message}`;
        resolve(-1);
      });
      child.on('close', (code) => resolve(code ?? -1));
    });

    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    const header = events.find((event) => event.type === 'session');
    let text = '';
    let reasoning = '';
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, raw: {} };
    for (const event of events) {
      if (event.type === 'message_update' && event.usage) usage = normalizeUsage(event.usage);
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const answer = contentFromMessage(event.message);
        if (answer.text.trim().length > 0) text = answer.text;
        if (answer.reasoning.trim().length > 0) reasoning = answer.reasoning;
        const messageUsage = event.message.usage ?? event.message.meta?.usage;
        if (messageUsage) usage = normalizeUsage(messageUsage);
      }
    }

    if (signal?.aborted) {
      throw new ProviderError('session_cancelled', `The ${kind} session was cancelled`, { kind, usage });
    }
    if (cancelled) {
      throw new ProviderError('session_timeout', `The ${kind} session passed its time limit of ${limit} ms`, { kind, limit, usage, stderr: truncate(stderr, 1000) });
    }
    if (exitCode !== 0) {
      throw new ProviderError('session_failed', `The ${kind} session exited with code ${exitCode}: ${truncate(stderr.trim() || 'no error text', 600)}`, {
        kind,
        exitCode,
        usage,
        stderr: truncate(stderr, 2000),
      });
    }

    return {
      text: text.trim(),
      reasoning: reasoning.trim(),
      sessionId: header?.id ?? sessionId ?? null,
      usage,
      events: events.map((event) => ({ type: event.type })),
      exitCode,
      stderr: truncate(stderr, 2000),
      model: model ?? this.config.provider.authorModel,
      toolNames: unique(events.filter((event) => event.type === 'tool_execution_start').map((event) => event.toolName)),
      stub: false,
    };
  }

  /** One evolve session inside the candidate workspace. It has file tools and sees the attached frames. */
  async author({ workspaceDir, prompt, images = [], systemPrompt, sessionId, signal, model, onEvent }) {
    return this.run({ kind: 'author', prompt, images, cwd: workspaceDir, sessionId, systemPrompt, signal, model, onEvent });
  }
}
