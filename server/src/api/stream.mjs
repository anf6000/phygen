// ─────────────────────────────────────────────────────────────────────────────
// stream.mjs — complete event replay for one run, then a live subscription.
//
// The order matters. A subscription that starts after a capped replay loses
// every event that arrived in between. So the subscription starts FIRST, live
// events are buffered, the complete historical range is paged up to the
// high-water sequence, and only then are the buffered events flushed in order.
//
// A client that cannot keep up is closed, never silently trimmed: it reconnects
// with its last received sequence and receives exactly what it missed.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_MAX_BUFFER = 5000;

/**
 * @param {object} options
 * @param {object} options.store
 * @param {object} options.events        the EventBus
 * @param {string} options.runId
 * @param {number} options.since         the client's last received sequence
 * @param {(event: object) => void} options.write
 * @param {(reason: string) => void} [options.onOverrun]
 * @returns {{stop: () => void, lastWritten: number, overran: boolean, buffered: number}}
 */
export function streamEvents({
  store,
  events,
  runId,
  since = 0,
  write,
  onOverrun = () => {},
  pageSize = DEFAULT_PAGE_SIZE,
  maxBuffer = DEFAULT_MAX_BUFFER,
}) {
  let lastWritten = since;
  let flushing = true;
  let stopped = false;
  let overran = false;
  const buffered = [];

  const emit = (event) => {
    if (stopped) return;
    write(event);
    lastWritten = event.seq;
  };

  const unsubscribe = events.subscribe(runId, (event) => {
    if (stopped) return;
    if (flushing) {
      buffered.push(event);
      if (buffered.length > maxBuffer) {
        overran = true;
        stopped = true;
        unsubscribe();
        onOverrun('the client fell further behind than the buffer allows');
      }
      return;
    }
    emit(event);
  });

  // The high-water sequence is read AFTER the subscription, so no event can
  // slip between the two.
  const highWater = store.latestEventSeq(runId);
  let cursor = since;
  while (cursor < highWater) {
    const page = store.listEvents(runId, cursor, pageSize);
    if (page.length === 0) break;
    for (const event of page) emit(event);
    cursor = page[page.length - 1].seq;
    if (page.length < pageSize) break;
  }

  flushing = false;
  if (!stopped) {
    for (const event of buffered.sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= lastWritten) continue;
      emit(event);
    }
  }
  buffered.length = 0;

  return {
    stop() {
      stopped = true;
      unsubscribe();
    },
    get lastWritten() {
      return lastWritten;
    },
    get overran() {
      return overran;
    },
    get buffered() {
      return buffered.length;
    },
  };
}
