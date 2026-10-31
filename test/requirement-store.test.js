import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openRequirementStore } from '../src/requirement-store.js';

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'checkproblem-requirements-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpFile(t, name = 'ledger.json') {
  return join(tmpDir(t), 'state', name);
}

function makeRequest(id) {
  return {
    id,
    chatId: 'oc_chat',
    triggerMessageId: `om_${id}`,
    cardMessageIds: [],
    initiatorId: 'ou_initiator',
    reviewerIds: ['ou_reviewer'],
    projectId: 'weapon',
    status: 'draft',
    snapshot: { documentId: `doc_${id}`, blocks: [{ id: 'b1', text: 'hello' }] },
    draft: { version: 1, facts: [], stories: [] },
    parentStoryId: null,
    submissions: [],
    viewByActor: {},
  };
}

function writeLedger(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

test('corrupt submission ledger never becomes an empty store', (t) => {
  const file = tmpFile(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{broken');
  assert.throws(() => openRequirementStore(file), { message: 'LEDGER_CORRUPT' });
});

test('a missing ledger opens empty and is not created by opening', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  t.after(() => store.close());
  assert.equal(store.get('req_1'), undefined);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(dirname(file)), false);
});

test('a request saved by transaction survives a reopen', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  await store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  await store.close();

  const reopened = openRequirementStore(file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.get('req_1'), makeRequest('req_1'));
  assert.deepEqual(reopened.list(), [makeRequest('req_1')]);
});

test('transaction returns fn result and persists draft mutations', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  t.after(() => store.close());

  const result = await store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
    next.requests.req_1.status = 'awaiting_review';
    next.requests.req_1.snapshot.blocks.push({ id: 'b2', text: 'world' });
    return { ok: true };
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(store.get('req_1').status, 'awaiting_review');
  assert.equal(store.get('req_1').snapshot.blocks.length, 2);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).requests.req_1.status, 'awaiting_review');
});

test('get and list return deep copies that cannot mutate store memory', async (t) => {
  const store = openRequirementStore(tmpFile(t));
  t.after(() => store.close());
  await store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });

  const got = store.get('req_1');
  got.status = 'tampered';
  got.snapshot.blocks[0].text = 'tampered';
  got.reviewerIds.push('ou_attacker');
  const listed = store.list();
  listed[0].status = 'tampered';
  listed.push(makeRequest('req_2'));

  assert.deepEqual(store.get('req_1'), makeRequest('req_1'));
  assert.equal(store.get('req_1').snapshot.blocks[0].text, 'hello');
  assert.deepEqual(store.list(), [makeRequest('req_1')]);
});

test('two transactions started without awaiting both persist', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  const first = store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  const second = store.transaction((next) => {
    next.requests.req_2 = makeRequest('req_2');
  });
  await Promise.all([first, second]);
  await store.close();

  const reopened = openRequirementStore(file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.list().map((request) => request.id), ['req_1', 'req_2']);
});

test('21 requests survive a reopen; the ledger is not pruned to the recent 20 reports', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  const ids = Array.from({ length: 21 }, (_, index) => `req_${index}`);
  await store.transaction((next) => {
    for (const id of ids) next.requests[id] = makeRequest(id);
  });
  await store.close();

  const reopened = openRequirementStore(file);
  t.after(() => reopened.close());
  assert.equal(reopened.list().length, 21);
  assert.deepEqual(reopened.list().map((request) => request.id), ids);
});

test('an unknown schema version is rejected, never reset to empty', (t) => {
  const file = tmpFile(t);
  writeLedger(file, { version: 2, requests: {} });
  assert.throws(() => openRequirementStore(file), { message: 'LEDGER_UNSUPPORTED' });
});

test('structurally malformed ledgers are corrupt', (t) => {
  const invalid = [
    { version: 1, requests: [] },
    { version: 1, requests: { req_1: 'not-an-object' } },
    { version: 1, requests: { req_1: null } },
    { version: '1', requests: {} },
    { requests: {} },
  ];
  for (const ledger of invalid) {
    const file = tmpFile(t);
    writeLedger(file, ledger);
    assert.throws(
      () => openRequirementStore(file),
      { message: 'LEDGER_CORRUPT' },
      `expected LEDGER_CORRUPT for ${JSON.stringify(ledger)}`,
    );
  }
});

test('a failed rename keeps memory and disk on the previous state and the queue recovers', async (t) => {
  const file = tmpFile(t);
  const seed = openRequirementStore(file);
  await seed.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  await seed.close();

  let failures = 1;
  const store = openRequirementStore(file, {
    io: {
      renameSync(from, to) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('rename failed');
        }
        return renameSync(from, to);
      },
    },
  });
  t.after(() => store.close());

  await assert.rejects(
    store.transaction((next) => {
      next.requests.req_2 = makeRequest('req_2');
    }),
    { message: 'rename failed' },
  );
  assert.equal(store.get('req_2'), undefined);
  assert.deepEqual(store.list().map((request) => request.id), ['req_1']);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).requests.req_2, undefined);

  await store.transaction((next) => {
    next.requests.req_2 = makeRequest('req_2');
  });
  assert.ok(store.get('req_2'));
  await store.close();

  const reopened = openRequirementStore(file);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.list().map((request) => request.id), ['req_1', 'req_2']);
});

test('a write failure leaves memory and disk unchanged', async (t) => {
  const file = tmpFile(t);
  let failures = 1;
  const store = openRequirementStore(file, {
    io: {
      writeFileSync(fd, data) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('disk full');
        }
        return writeFileSync(fd, data);
      },
    },
  });
  t.after(() => store.close());

  await assert.rejects(
    store.transaction((next) => {
      next.requests.req_1 = makeRequest('req_1');
    }),
    { message: 'disk full' },
  );
  assert.equal(store.get('req_1'), undefined);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false);
});

test('an fsync failure leaves memory and disk unchanged', async (t) => {
  const file = tmpFile(t);
  let failures = 1;
  const store = openRequirementStore(file, {
    io: {
      fsyncSync(fd) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('flush failed');
        }
        return fsyncSync(fd);
      },
    },
  });
  t.after(() => store.close());

  await assert.rejects(
    store.transaction((next) => {
      next.requests.req_1 = makeRequest('req_1');
    }),
    { message: 'flush failed' },
  );
  assert.equal(store.get('req_1'), undefined);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false);
});

test('fn throwing writes nothing and leaves memory unchanged', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  t.after(() => store.close());
  await store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  const before = readFileSync(file, 'utf8');

  await assert.rejects(
    store.transaction((next) => {
      next.requests.req_1.status = 'tampered';
      throw new Error('boom');
    }),
    { message: 'boom' },
  );
  assert.deepEqual(store.list(), [makeRequest('req_1')]);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('transaction after close rejects with STORE_CLOSED', async (t) => {
  const store = openRequirementStore(tmpFile(t));
  await store.close();
  await assert.rejects(store.transaction(() => {}), { message: 'STORE_CLOSED' });
});

test('close waits for an already queued transaction to persist', async (t) => {
  const file = tmpFile(t);
  const store = openRequirementStore(file);
  const pending = store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  await Promise.all([pending, store.close()]);

  const reopened = openRequirementStore(file);
  t.after(() => reopened.close());
  assert.ok(reopened.get('req_1'));
});

test('atomic writes rename a unique temp path onto the ledger', async (t) => {
  const file = tmpFile(t);
  const renames = [];
  const store = openRequirementStore(file, {
    io: {
      renameSync(from, to) {
        renames.push([from, to]);
        return renameSync(from, to);
      },
    },
  });
  t.after(() => store.close());

  await store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  await store.transaction((next) => {
    next.requests.req_2 = makeRequest('req_2');
  });

  assert.equal(renames.length, 2);
  for (const [from, to] of renames) {
    assert.equal(to, file);
    assert.notEqual(from, file);
    assert.equal(dirname(from), dirname(file));
    assert.equal(existsSync(from), false);
  }
  assert.notEqual(renames[0][0], renames[1][0]);
});

test('non-ENOENT read errors propagate unchanged', (t) => {
  const failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
  assert.throws(
    () => openRequirementStore(tmpFile(t), { io: { readFileSync() { throw failure; } } }),
    (error) => error === failure,
  );
});

// Keep the injectable-I/O defaults honest: a store opened without overrides
// must use the real fs primitives listed in the contract.
test('default io uses fsync and fd-based writes', async (t) => {
  const file = tmpFile(t);
  const calls = [];
  const store = openRequirementStore(file, {
    io: {
      openSync(path, flags) {
        calls.push(['open', path, flags]);
        return openSync(path, flags);
      },
      closeSync(fd) {
        calls.push(['close']);
        return closeSync(fd);
      },
    },
  });
  t.after(() => store.close());
  await store.transaction((next) => {
    next.requests.req_1 = makeRequest('req_1');
  });
  assert.deepEqual(calls.map(([name]) => name), ['open', 'close']);
  assert.equal(calls[0][2], 'w');
  assert.ok(existsSync(file));
});
