'use strict';

// The chapter saver (web/public/web-saves.js): a write whose answer was
// lost counts as saved when the server already holds the words, a write that
// never landed is sent again until it does, newer words supersede older ones
// on their way, and only an error the server meant gives up.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaver } = require('../public/web-saves.js');

const transient = (message) => Object.assign(new Error(message), { transient: true });

/** A pretend server: `held` is what it has, `answers` scripts each send's outcome in order. */
function fakeServer(answers) {
  const server = { held: '<p>old</p>', sent: [], naps: [] };
  server.transport = {
    send: async (html) => {
      server.sent.push(html);
      const outcome = answers.shift() || 'ok';
      if (outcome === 'ok') { server.held = html; return true; }
      if (outcome === 'lost') { server.held = html; throw transient('Load failed'); } // landed, answer gone
      if (outcome === 'down') throw transient('502');
      throw new Error(outcome); // the server meant it
    },
    readBack: async () => server.held
  };
  return server;
}

const quietSaver = (server, extra = {}) => createSaver({ wait: 1, maxWait: 4, sleep: async (ms) => { server.naps.push(ms); }, ...extra });

test('a lost answer is not a lost save: the read-back shows the words landed', async () => {
  const server = fakeServer(['lost']);
  const saver = quietSaver(server);
  assert.equal(await saver.save('b/ch-1', '<p>new</p>', server.transport), true);
  assert.deepEqual(server.sent, ['<p>new</p>'], 'sent once, never resent');
  assert.equal(saver.pending(), 0);
});

test('a save that never landed is sent again, with a growing pause, until it does', async () => {
  const server = fakeServer(['down', 'down', 'ok']);
  const stalls = [];
  const saver = quietSaver(server, { onStall: (key, attempt) => stalls.push(attempt) });
  await saver.save('b/ch-1', '<p>new</p>', server.transport);
  assert.equal(server.sent.length, 3);
  assert.equal(server.held, '<p>new</p>');
  assert.deepEqual(server.naps, [1, 2]);
  assert.deepEqual(stalls, [1, 2]);
});

test('newer words supersede older ones still on their way; both callers hear once the newest landed', async () => {
  const server = fakeServer(['down', 'ok']);
  const saver = quietSaver(server);
  const first = saver.save('b/ch-1', '<p>one</p>', server.transport);
  const second = saver.save('b/ch-1', '<p>one two</p>', server.transport);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(server.sent, ['<p>one</p>', '<p>one two</p>'], 'the older words were never resent on their own');
  assert.equal(server.held, '<p>one two</p>');
});

test('an error the server meant rejects, and the lane is free for the next save', async () => {
  const server = fakeServer(['Bad chapter name', 'ok']);
  const saver = quietSaver(server);
  await assert.rejects(saver.save('b/ch-1', '<p>x</p>', server.transport), /Bad chapter name/);
  assert.equal(saver.pending(), 0);
  assert.equal(await saver.save('b/ch-1', '<p>y</p>', server.transport), true);
});

test('a final error on words already superseded is moot: the newest version still goes out', async () => {
  const server = fakeServer(['Too big', 'ok']);
  const saver = quietSaver(server);
  const first = saver.save('b/ch-1', '<p>one</p>', server.transport);
  const second = saver.save('b/ch-1', '<p>two</p>', server.transport);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(server.held, '<p>two</p>');
});

test('a read-back that fails is not a confirmation', async () => {
  const server = fakeServer(['lost', 'ok']);
  const transport = { ...server.transport, readBack: async () => { throw transient('No connection'); } };
  const saver = quietSaver(server);
  await saver.save('b/ch-1', '<p>new</p>', transport);
  assert.equal(server.sent.length, 2, 'sent again, since nothing proved it landed');
});

test('chapters have lanes of their own', async () => {
  const server = fakeServer(['down', 'ok', 'ok']);
  const saver = quietSaver(server);
  const slow = saver.save('b/ch-1', '<p>one</p>', server.transport);
  const quick = saver.save('b/ch-2', '<p>two</p>', server.transport);
  await quick;
  assert.equal(saver.pending(), 1, 'the other chapter is still on its way');
  await slow;
  assert.equal(saver.pending(), 0);
});

test('stalled counts the lanes that failed once, not a healthy save on its way', async () => {
  const server = fakeServer(['down', 'ok']);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const saver = createSaver({ wait: 1, sleep: () => gate });
  const saving = saver.save('b/ch-1', '<p>one</p>', server.transport);
  assert.equal(saver.stalled(), 0, 'nothing has failed yet');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saver.pending(), 1);
  assert.equal(saver.stalled(), 1, 'the first attempt failed');
  release();
  await saving;
  assert.equal(saver.stalled(), 0);
});
