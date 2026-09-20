import assert from 'node:assert/strict';
import { test } from 'node:test';

import { feedRows } from '../src/controller/agent-events.mjs';

test('the attachment tags of the provider are removed from the answer text', () => {
  const event = {
    type: 'message_update',
    delta: 'Here is the frame: <file name="C:\\data\\captures\\late.png"></file> and the result.',
  };
  const rows = feedRows(event, 'ver_one');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'text');
  assert.equal(rows[0].text, 'Here is the frame:  and the result.');

  // A row that holds nothing else is dropped.
  assert.deepEqual(feedRows({ type: 'message_update', delta: '<file name="x.png"></file>' }, 'ver_one'), []);
});

test('a reasoning block becomes a reason row, kept separate from the answer text', () => {
  const event = {
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'The parent already doubled the particles. Try the decay next.' }],
    },
  };
  const rows = feedRows(event, 'ver_one');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'reason');
  assert.match(rows[0].text, /doubled the particles/);

  // An answer block in the same stream is a text row, never a reason row.
  const answer = feedRows({ type: 'message_update', delta: 'Files changed: src/physarum.js, config.json.' }, 'ver_one');
  assert.equal(answer.length, 1);
  assert.equal(answer[0].kind, 'text');

  // A final message that holds reasoning and an answer becomes two rows: the
  // reasoning, then the answer text.
  const end = feedRows(
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'redacted_thinking', text: 'checking the schema' }, { type: 'text', text: 'Files changed: config.json' }],
      },
    },
    'ver_one',
  );
  assert.equal(end.length, 2);
  assert.equal(end[0].kind, 'reason');
  assert.equal(end[0].text, 'checking the schema');
  assert.equal(end[1].kind, 'text');
  assert.equal(end[1].text, 'Files changed: config.json');

  // A final message with an answer and no reasoning is one text row.
  const answerOnly = feedRows({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, 'ver_one');
  assert.deepEqual(
    answerOnly.map((row) => row.kind),
    ['text'],
  );
});

test('a long text row is capped at 4000 characters, not at 160', () => {
  const long = 'x'.repeat(5000);
  const rows = feedRows({ type: 'message_update', delta: long }, 'ver_one');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'text');
  assert.equal(rows[0].text.length, 4000, 'the row keeps the tail, capped at 4000');

  // A normal sentence is not cut at 160 characters.
  const sentence = `${'sentence. '.repeat(30)}`.trim();
  assert.ok(sentence.length > 160);
  const kept = feedRows({ type: 'message_update', delta: sentence }, 'ver_one');
  assert.equal(kept[0].text, sentence);
});
