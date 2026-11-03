import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockServer } from '../../../../../mobile-engineer-kit/mock-server.mjs';
import { createImportApi, ImportApiError, parseImportJob } from './importApi.ts';

const fixtureUrl = new URL('../../../../../mobile-engineer-kit/fixtures/statement.csv', import.meta.url);
const bytes = await readFile(fixtureUrl);
const file = { uri: fixtureUrl.href, name: 'statement.csv', size: bytes.length, format: 'csv' };
const queued = { jobId: 'job-demo-001', status: 'queued', revision: 1 };
const ready = {
  jobId: 'job-demo-001', status: 'ready', revision: 3, currency: 'AUD',
  items: [{ id: 'rec-001', merchant: 'StreamBeam', amountMinor: 1999, cadence: 'monthly', lastSeen: '2026-10-01' }],
};

async function withMock(t, mode = 'happy') {
  const directory = await mkdtemp(join(tmpdir(), 'statement-import-api-'));
  const server = createMockServer({ statePath: join(directory, 'state.json') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (mode !== 'happy') {
    const result = await fetch(`${baseUrl}/__test/scenario`, { method: 'POST', body: JSON.stringify({ mode }) });
    assert.equal(result.status, 200);
  }
  return {
    baseUrl,
    api: createImportApi({ baseUrl, fetch, bodyForFile: () => bytes }),
    state: async () => (await fetch(`${baseUrl}/__test/state`)).json(),
  };
}

test('real mock receives the exact fixture bytes, returns accepted then authoritative ready', async t => {
  const { api, state } = await withMock(t);
  const accepted = await api.create('stable-key-happy', file);
  assert.deepEqual(accepted, queued);
  let result = await api.get(accepted.jobId);
  const deadline = Date.now() + 4000;
  while (result.status !== 'ready' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await api.get(accepted.jobId);
  }
  assert.equal(result.status, 'ready');
  assert.equal(result.currency, 'AUD');
  assert.equal(result.items.length, 2);
  assert.equal(result.items.reduce((sum, item) => sum + item.amountMinor, 0), 15199);
  const observed = await state();
  assert.equal(observed.stats.createRequests, 1);
  assert.equal(observed.stats.newJobs, 1);
  assert.equal(observed.stats.acceptedBytes, bytes.length);
  assert.equal(observed.jobs[0].sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('real lost_ack is unknown; lookup and same-key retry preserve one server job', async t => {
  const { api, state } = await withMock(t, 'lost_ack');
  await assert.rejects(api.create('stable-key-lost', file), error => {
    assert.ok(error instanceof ImportApiError);
    assert.equal(error.outcome, 'unknown');
    return true;
  });
  const recovered = await api.findByKey('stable-key-lost');
  assert.equal(recovered.jobId, 'job-demo-001');
  const repeated = await api.create('stable-key-lost', file);
  assert.equal(repeated.jobId, recovered.jobId);
  const observed = await state();
  assert.equal(observed.stats.newJobs, 1);
  assert.equal(observed.stats.createRequests, 2);
  assert.equal(observed.stats.duplicateHits, 1);
  assert.equal(observed.stats.acceptedBytes, bytes.length);
});

test('real stale_status exposes revisions for the model to reject the older response', async t => {
  const { api } = await withMock(t, 'stale_status');
  const accepted = await api.create('stable-key-stale', file);
  const current = await api.get(accepted.jobId);
  const stale = await api.get(accepted.jobId);
  assert.equal(current.status, 'ready');
  assert.equal(current.revision, 3);
  assert.equal(stale.status, 'processing');
  assert.equal(stale.revision, 2);
});

test('real by-key 404 is only a point-in-time missing result', async t => {
  const { api } = await withMock(t);
  assert.equal(await api.findByKey('stable-key-missing'), null);
  assert.equal((await api.create('stable-key-missing', file)).jobId, queued.jobId);
  assert.equal((await api.findByKey('stable-key-missing')).jobId, queued.jobId);
});

test('real mock rejects changed bytes under the existing key without creating another job', async t => {
  const { api, baseUrl, state } = await withMock(t);
  await api.create('stable-key-conflict', file);
  const changedApi = createImportApi({
    baseUrl,
    fetch,
    bodyForFile: () => Buffer.concat([bytes, Buffer.from('\n')]),
  });
  await assert.rejects(changedApi.create('stable-key-conflict', file), error => {
    assert.equal(error.status, 409);
    assert.equal(error.outcome, 'rejected');
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes('sensitive detail'));
    return true;
  });
  assert.equal((await state()).stats.newJobs, 1);
  assert.equal((await state()).stats.createRequests, 2);
});

test('request uses raw body and required headers, including a safe Unicode filename', async () => {
  let captured;
  const body = new Uint8Array([1, 2, 3]);
  const api = createImportApi({
    baseUrl: 'http://local.test/', bodyForFile: () => body,
    fetch: async (url, options) => {
      captured = { url, options };
      return { status: 202, json: async () => queued };
    },
  });
  await api.create('stable-key-headers', { ...file, name: 'Выписка\r\n.csv' });
  assert.equal(captured.url, 'http://local.test/imports');
  assert.equal(captured.options.body, body);
  assert.equal(captured.options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(captured.options.headers['Idempotency-Key'], 'stable-key-headers');
  assert.equal(captured.options.headers['X-File-Name'], encodeURIComponent('Выписка\r\n.csv'));
  assert.ok(captured.options.signal instanceof AbortSignal);
});

test('transport and response-body errors do not leak backend or native details', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private-file.csv raw error'); },
    async () => ({ status: 200, json: async () => { throw new Error('private transaction'); } }),
    async () => ({ status: 503, json: async () => ({ error: 'private transaction' }) }),
  ]) {
    const api = createImportApi({ baseUrl: '', fetch: fetchImpl, bodyForFile: () => bytes });
    await assert.rejects(api.get(queued.jobId), error => {
      assert.ok(error instanceof ImportApiError);
      assert.equal(error.outcome, 'unknown');
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('unreadable local copy fails before any network request', async () => {
  let calls = 0;
  const api = createImportApi({
    baseUrl: '', fetch: async () => { calls++; throw new Error('unexpected'); },
    bodyForFile: () => { throw new Error('private-file.csv'); },
  });
  await assert.rejects(api.create('stable-key-read', file), error => {
    assert.equal(error.outcome, 'rejected');
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes('private'));
    return true;
  });
  assert.equal(calls, 0);
});

test('an HTTP request timeout has an unknown create outcome', async () => {
  const api = createImportApi({
    baseUrl: '', bodyForFile: () => bytes,
    fetch: async () => ({ status: 408, json: async () => ({ error: 'timeout' }) }),
  });
  await assert.rejects(api.create('stable-key-http-timeout', file), error => {
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('timeout aborts and settles even if the transport ignores AbortSignal', async () => {
  let signal;
  const api = createImportApi({
    baseUrl: '', timeoutMs: 10, bodyForFile: () => bytes,
    fetch: async (_url, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  await assert.rejects(api.create('stable-key-timeout', file), error => error.outcome === 'unknown');
  assert.equal(signal.aborted, true);
});

test('GET rejects a job identity mismatch and POST never treats ready as acceptance', async () => {
  const getApi = createImportApi({
    baseUrl: '', bodyForFile: () => bytes,
    fetch: async () => ({ status: 200, json: async () => queued }),
  });
  await assert.rejects(getApi.get('job-demo-999'), ImportApiError);
  const postApi = createImportApi({
    baseUrl: '', bodyForFile: () => bytes,
    fetch: async () => ({ status: 202, json: async () => ready }),
  });
  await assert.rejects(postApi.create('stable-key-status', file), ImportApiError);
});

test('report validation rejects malformed revisions, money, dates, duplicate items and unknown statuses', () => {
  assert.deepEqual(parseImportJob(ready), ready);
  const badValues = [
    null, {}, { ...queued, revision: 0 }, { ...queued, revision: 1.5 },
    { ...queued, status: 'completed' }, { ...ready, currency: 'aud' },
    { ...ready, items: [ready.items[0], ready.items[0]] },
    ...[
      { amountMinor: 1.5 }, { amountMinor: -1 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { lastSeen: '2026-02-30' }, { cadence: 'weekly' }, { merchant: '' },
    ].map(changes => ({ ...ready, items: [{ ...ready.items[0], ...changes }] })),
  ];
  for (const value of badValues) assert.throws(() => parseImportJob(value), ImportApiError);
});

test('real deletion failure preserves job; same-key retry returns acceptance then GET confirms deleted', async t => {
  const { baseUrl, api, state } = await withMock(t, 'delete_failure');
  const accepted = await api.create('create-key-delete-test', file);
  const deleteKey = 'delete-key-stable-test';
  await assert.rejects(api.remove(accepted.jobId, deleteKey), error => {
    assert.ok(error instanceof ImportApiError);
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.equal(error.outcome, 'unknown');
    return true;
  });
  const before = await api.get(accepted.jobId);
  assert.notEqual(before.status, 'deleting');
  assert.notEqual(before.status, 'deleted');
  assert.equal((await state()).stats.deleteRequests, 1);
  await fetch(`${baseUrl}/__test/scenario`, { method: 'POST', body: JSON.stringify({ mode: 'happy' }) });
  const acknowledgement = await api.remove(accepted.jobId, deleteKey);
  assert.equal(acknowledgement.status, 'deleting');
  assert.equal(acknowledgement.revision, 4);
  let result = await api.get(accepted.jobId);
  const deadline = Date.now() + 4000;
  while (result.status !== 'deleted' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await api.get(accepted.jobId);
  }
  assert.equal(result.status, 'deleted');
  assert.equal(result.revision, 5);
  assert.equal((await api.remove(accepted.jobId, deleteKey)).status, 'deleted');
  const observed = await state();
  assert.equal(observed.stats.deleteRequests, 3);
  assert.equal(observed.stats.newJobs, 1);
  assert.equal(observed.jobs[0].status, 'deleted');
});

test('DELETE sends stable key with no file body and validates accepted identity/status', async () => {
  let captured;
  const deleting = { ...queued, status: 'deleting', revision: 4 };
  let response = deleting;
  let responseStatus = 202;
  const api = createImportApi({
    baseUrl: 'http://local.test',
    bodyForFile: () => { throw new Error('Delete must never read the payload'); },
    fetch: async (url, options) => {
      captured = { url, options };
      return { status: responseStatus, json: async () => response };
    },
  });
  assert.deepEqual(await api.remove(queued.jobId, 'delete-key-headers'), deleting);
  assert.equal(captured.url, 'http://local.test/imports/job-demo-001');
  assert.equal(captured.options.method, 'DELETE');
  assert.equal(captured.options.headers['Idempotency-Key'], 'delete-key-headers');
  assert.equal(captured.options.headers['X-File-Name'], undefined);
  assert.equal(captured.options.body, undefined);
  for (const invalid of [ready, queued, { ...deleting, jobId: 'job-demo-999' }]) {
    response = invalid;
    await assert.rejects(api.remove(queued.jobId, 'delete-key-headers'), ImportApiError);
  }
  response = deleting;
  responseStatus = 200;
  await assert.rejects(api.remove(queued.jobId, 'delete-key-headers'), ImportApiError);
});
