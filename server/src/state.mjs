// ─────────────────────────────────────────────────────────────────────────────
// state.mjs — the run, version, and job state machines.
//
// Every transition passes through one function, so an invalid transition is an
// error and never a silent state change. The controller owns these states.
// ─────────────────────────────────────────────────────────────────────────────
import { ArtworkError } from '../../runtime/contract.js';

export const RUN_STATES = Object.freeze(['queued', 'running', 'paused', 'stopping', 'stopped', 'completed', 'failed']);
export const TERMINAL_RUN_STATES = Object.freeze(['stopped', 'completed', 'failed']);

export const VERSION_STATES = Object.freeze([
  'queued',
  'authoring',
  'validating',
  'capturing',
  'promoted',
  'failed',
]);
export const TERMINAL_VERSION_STATES = Object.freeze(['promoted', 'failed']);

export const JOB_KINDS = Object.freeze(['author', 'capture', 'publish']);
export const JOB_STATES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled']);
export const TERMINAL_JOB_STATES = Object.freeze(['done', 'failed', 'cancelled']);

const RUN_TRANSITIONS = {
  queued: ['running', 'paused', 'stopped', 'failed'],
  running: ['running', 'paused', 'stopping', 'completed', 'failed', 'stopped'],
  paused: ['running', 'stopping', 'stopped', 'failed'],
  stopping: ['stopped', 'failed', 'completed', 'paused'],
  stopped: [],
  completed: [],
  failed: [],
};

const VERSION_TRANSITIONS = {
  queued: ['authoring', 'failed'],
  authoring: ['validating', 'failed'],
  validating: ['capturing', 'failed'],
  capturing: ['promoted', 'failed'],
  promoted: [],
  failed: [],
};

const JOB_TRANSITIONS = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export const MACHINES = Object.freeze({
  run: { states: RUN_STATES, transitions: RUN_TRANSITIONS },
  version: { states: VERSION_STATES, transitions: VERSION_TRANSITIONS },
  job: { states: JOB_STATES, transitions: JOB_TRANSITIONS },
});

/** The new state of a machine, or an error that names both states. */
export function transition(machine, from, to) {
  const definition = MACHINES[machine];
  if (!definition) throw new ArtworkError('state_machine_unknown', `Unknown state machine: ${machine}`);
  if (!definition.states.includes(to)) {
    throw new ArtworkError('state_invalid', `${machine} has no state ${to}`, { machine, state: to });
  }
  if (from === to) return to;
  const allowed = definition.transitions[from];
  if (!allowed) {
    throw new ArtworkError('state_invalid', `${machine} has no state ${from}`, { machine, state: from });
  }
  if (!allowed.includes(to)) {
    throw new ArtworkError('state_transition_invalid', `${machine} cannot go from ${from} to ${to}`, {
      machine,
      from,
      to,
      allowed,
    });
  }
  return to;
}

export function canTransition(machine, from, to) {
  try {
    transition(machine, from, to);
    return true;
  } catch {
    return false;
  }
}

export function isTerminal(machine, state) {
  if (machine === 'run') return TERMINAL_RUN_STATES.includes(state);
  if (machine === 'version') return TERMINAL_VERSION_STATES.includes(state);
  return TERMINAL_JOB_STATES.includes(state);
}
