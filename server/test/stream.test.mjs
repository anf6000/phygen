// Event replay: a client that reconnects must receive every stored event once,
// in order, even while new events arrive during the replay.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Store } from '../src/db.mjs';
import { EventBus } from '../src/events.mjs';
import { streamEvents } from '../src/api/stream.mjs';

function makeStore(t) {
  return mkdtemp(join(tmpdir(), 'phygen-stream-')).then((dir) => {
    t.after(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    });
    return new Store(join(dir, 'phygen.db'));
  });
}

test('a slow client receives the complete range with no gap and no duplicate', async (t) => {
  const store = await makeStore(t);
  t.after(() => store.close());
  const events = new EventBus(store);
  const runId = 'run_replay';

  for (let index = 0; index < 1200; index++) events.emit(runId, 'tick', { index });

  // The replay reaches 500 records, then 300 more live events arrive before the
  // next page is read.
  const received = [];
  let emittedLive = 0;
  const stream = streamEvents({
    store,
    events,
    runId,
    since: 0,
    write: (event) => {
      received.push(event.seq);
      if (received.length === 500 && emittedLive === 0) {
        for (let index = 0; index < 300; index++) {
          emittedLive += 1;
          events.emit(runId, 'live', { index });
        }
      }
    },
  });
  // 300 more while the subscription is live.
  for (let index = 0; index < 300; index++) {
    emittedLive += 1;
    events.emit(runId, 'live', { index });
  }
  stream.stop();

  const total = store.latestEventSeq(runId);
  assert.equal(total, 1200 + 600);
  assert.equal(received.length, total, 'every stored event was delivered');
  assert.equal(new Set(received).size, received.length, 'no duplicate');
  for (let index = 1; index < received.length; index++) {
    assert.ok(received[index] > received[index - 1], 'the order is strict');
  }
  assert.equal(received[0], 1);
  assert.equal(received[received.length - 1], total);
});

test('a reconnecting client resumes from its last sequence', async (t) => {
  const store = await makeStore(t);
  t.after(() => store.close());
  const events = new EventBus(store);
  const runId = 'run_resume';
  for (let index = 0; index < 1200; index++) events.emit(runId, 'tick', { index });

  const first = [];
  const stream = streamEvents({ store, events, runId, since: 0, write: (event) => first.push(event.seq) });
  stream.stop();
  const resumeFrom = first[first.length - 1];

  for (let index = 0; index < 40; index++) events.emit(runId, 'more', { index });
  const second = [];
  const resumed = streamEvents({ store, events, runId, since: resumeFrom, write: (event) => second.push(event.seq) });
  resumed.stop();

  assert.equal(second[0], resumeFrom + 1);
  assert.equal(second.length, 40);
  assert.equal(resumed.lastWritten, store.latestEventSeq(runId));
});

test('a client that falls too far behind is closed instead of trimmed', async (t) => {
  const store = await makeStore(t);
  t.after(() => store.close());
  const events = new EventBus(store);
  const runId = 'run_overrun';
  for (let index = 0; index < 100; index++) events.emit(runId, 'tick', { index });

  const received = [];
  let overran = false;
  const stream = streamEvents({
    store,
    events,
    runId,
    since: 0,
    maxBuffer: 10,
    write: (event) => {
      received.push(event.seq);
      if (received.length === 1) {
        for (let index = 0; index < 50; index++) events.emit(runId, 'flood', { index });
      }
    },
    onOverrun: () => {
      overran = true;
    },
  });

  assert.equal(overran, true, 'the client is told to reconnect');
  assert.equal(stream.overran, true);
  assert.ok(received.length < 150, 'the stream stopped instead of buffering without bound');
  stream.stop();
});
