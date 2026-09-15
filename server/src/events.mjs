// ─────────────────────────────────────────────────────────────────────────────
// events.mjs — the progress log and its subscribers.
//
// Every event is stored before it is published, so a client that reconnects
// with Last-Event-ID replays exactly what it missed.
// ─────────────────────────────────────────────────────────────────────────────
export class EventBus {
  constructor(store) {
    this.store = store;
    this.subscribers = new Map();
  }

  /** Store one event, then hand it to the live subscribers of that run. */
  emit(runId, type, payload = {}) {
    const event = this.store.appendEvent(runId, type, payload);
    for (const subscriber of this.subscribers.get(runId) ?? []) {
      try {
        subscriber(event);
      } catch {
        // a broken subscriber must not stop the run
      }
    }
    return event;
  }

  subscribe(runId, handler) {
    const set = this.subscribers.get(runId) ?? new Set();
    set.add(handler);
    this.subscribers.set(runId, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.subscribers.delete(runId);
    };
  }

  since(runId, seq) {
    return this.store.listEvents(runId, seq);
  }
}

