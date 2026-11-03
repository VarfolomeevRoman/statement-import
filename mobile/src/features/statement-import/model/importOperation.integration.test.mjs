// Host integration: real HTTP mock + disk journal + fresh model instances.
// This does not replace running the Expo filesystem adapter on a native device.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { createMockServer } from '../../../../../mobile-engineer-kit/mock-server.mjs';
import { createImportApi } from '../api/importApi.ts';
import { createImportStorageJournal } from '../lib/importStorageJournal.ts';
import { validateStatementContent } from '../lib/validateStatementFile.ts';
import { createImportOperation } from './importOperation.ts';

const source = new URL('../../../../../mobile-engineer-kit/fixtures/statement.csv', import.meta.url);
const key = '00000000-0000-4000-8000-000000000001';

async function setup(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'statement-import-flow-'));
  const directory = join(root, 'documents');
  const selectedPath = join(root, 'selected.csv');
  await copyFile(source, selectedPath);
  const expectedBytes = await readFile(selectedPath);
  const file = {
    uri: pathToFileURL(selectedPath).href,
    name: 'statement.csv', size: expectedBytes.length, format: 'csv',
  };
  const files = {
    ensure() { mkdirSync(directory, { recursive: true }); },
    list() { return readdirSync(directory); },
    uri(name) { return pathToFileURL(join(directory, name)).href; },
    exists(name) { return existsSync(join(directory, name)); },
    size(name) { return statSync(join(directory, name)).size; },
    read(name) { return readFile(join(directory, name), 'utf8'); },
    async writeExclusive(name, content) {
      const handle = await open(join(directory, name), 'wx');
      try { await handle.writeFile(content); }
      finally { await handle.close(); }
    },
    async copyFrom(selected, name) {
      await copyFile(fileURLToPath(selected.uri), join(directory, name), 1);
    },
    async commit(temporary, destination) {
      assert.equal(existsSync(join(directory, destination)), false);
      await rename(join(directory, temporary), join(directory, destination));
    },
    async remove(name) { await rm(join(directory, name), { force: true }); },
  };
  const server = createMockServer({ statePath: join(root, 'mock-state.json') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const models = [];
  t.after(async () => {
    for (const model of models) model.deactivate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${baseUrl}/__test/scenario`, { method: 'POST', body: JSON.stringify({ mode }) });
  const requests = [];
  const api = createImportApi({
    baseUrl,
    fetch: async (url, options) => {
      requests.push({
        method: options.method, path: new URL(url).pathname,
        idempotencyKey: options.headers['Idempotency-Key'],
      });
      return fetch(url, options);
    },
    bodyForFile: selected => readFile(fileURLToPath(selected.uri)),
  });
  const freshStorage = () => createImportStorageJournal(files);
  let keySequence = 0;
  return {
    file, files, expectedBytes, requests, api, freshStorage,
    async selection(name, bytes) {
      const selected = join(root, name);
      await writeFile(selected, bytes);
      return { uri: pathToFileURL(selected).href, name, size: bytes.length, format: 'csv' };
    },
    model(overrides = {}) {
      const model = createImportOperation({
        api, storage: freshStorage(),
        createKey: () => `00000000-0000-4000-8000-${String(++keySequence).padStart(12, '0')}`,
        // Each refresh below is explicit, making stale responses deterministic.
        schedule: () => () => {},
        ...overrides,
      });
      models.push(model);
      return model;
    },
    async serverState() { return (await fetch(`${baseUrl}/__test/state`)).json(); },
    async scenario(mode) {
      const response = await fetch(`${baseUrl}/__test/scenario`, {
        method: 'POST', body: JSON.stringify({ mode }),
      });
      assert.equal(response.status, 200);
    },
  };
}

async function reachReady(model) {
  const deadline = Date.now() + 4000;
  while (model.getSnapshot().phase !== 'ready' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    await model.refresh();
  }
  assert.equal(model.getSnapshot().phase, 'ready');
}

async function reachDeleted(model) {
  const deadline = Date.now() + 4000;
  while (model.getSnapshot().phase !== 'deleted' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    await model.refresh();
  }
  assert.equal(model.getSnapshot().phase, 'deleted');
}

test('lost_ack followed by deactivation restores from disk by key, without another POST', async t => {
  const f = await setup(t, 'lost_ack');
  let first;
  let persistedPayloadUri;
  first = f.model({
    api: {
      ...f.api,
      async create(operationKey, selected) {
        const saved = await f.freshStorage().load();
        assert.equal(saved.key, operationKey);
        assert.equal(saved.file.uri, selected.uri);
        assert.equal(saved.checkpoint, null);
        assert.notEqual(selected.uri, f.file.uri);
        assert.deepEqual(await readFile(fileURLToPath(selected.uri)), f.expectedBytes);
        persistedPayloadUri = selected.uri;
        try { return await f.api.create(operationKey, selected); }
        catch (error) {
          // Simulate loss of the app before the model can recover the dropped ACK.
          first.deactivate();
          throw error;
        }
      },
    },
  });
  await first.activate();
  await first.confirm(f.file);
  assert.deepEqual(f.requests.map(request => request.method), ['POST']);
  const beforeRestart = await f.freshStorage().load();
  assert.equal(beforeRestart.key, key);
  assert.equal(beforeRestart.checkpoint, null);
  assert.equal(existsSync(fileURLToPath(persistedPayloadUri)), true);

  const second = f.model({ createKey() { throw new Error('Relaunch must not generate another key'); } });
  await second.activate();
  assert.equal(f.requests[1].path, `/imports/by-key/${key}`);
  await reachReady(second);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(second.getSnapshot().job.items.reduce((sum, item) => sum + item.amountMinor, 0), 15199);
  const restored = await f.freshStorage().load();
  assert.equal(restored.key, key);
  assert.equal(restored.checkpoint.jobId, 'job-demo-001');
  assert.equal(restored.checkpoint.revision, 3);
  assert.equal(restored.file, null);
  assert.equal(existsSync(fileURLToPath(persistedPayloadUri)), false);
  assert.deepEqual(await readFile(fileURLToPath(f.file.uri)), f.expectedBytes);

  const observed = await f.serverState();
  assert.equal(observed.stats.newJobs, 1);
  assert.equal(observed.stats.createRequests, 1);
  assert.equal(observed.stats.acceptedBytes, f.expectedBytes.length);
  assert.equal(observed.jobs[0].sha256, createHash('sha256').update(f.expectedBytes).digest('hex'));
});

test('real stale_status cannot roll the UI or disk checkpoint back from ready to processing', async t => {
  const f = await setup(t, 'stale_status');
  const model = f.model();
  await model.activate();
  await model.confirm(f.file);
  assert.equal(model.getSnapshot().phase, 'ready');
  const report = model.getSnapshot().job;
  assert.equal(report.revision, 3);

  // The second GET in this real mock scenario returns processing/revision 2.
  await model.refresh();
  assert.equal(model.getSnapshot().phase, 'ready');
  assert.deepEqual(model.getSnapshot().job, report);
  const persisted = await f.freshStorage().load();
  assert.equal(persisted.checkpoint.status, 'ready');
  assert.equal(persisted.checkpoint.revision, 3);
  assert.equal((await f.serverState()).stats.newJobs, 1);

  model.deactivate();
  const restored = f.model();
  await restored.activate();
  assert.equal(restored.getSnapshot().phase, 'ready');
  assert.deepEqual(restored.getSnapshot().job, report);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('a saved operation missing on the server is never uploaded on relaunch; explicit retry keeps its key', async t => {
  const f = await setup(t, 'happy');
  const storage = f.freshStorage();
  const staged = await storage.stage(f.file, key);
  await storage.save({ version: 1, key, file: staged, checkpoint: null });

  const model = f.model({ createKey() { throw new Error('Existing operation must keep its key'); } });
  await model.activate();
  assert.equal(model.getSnapshot().phase, 'error');
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
  assert.equal((await f.serverState()).stats.newJobs, 0);
  await model.refresh();
  assert.equal(f.requests.some(request => request.method === 'POST'), false);

  await model.retry();
  await reachReady(model);
  assert.equal(model.getSnapshot().operation.key, key);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  const observed = await f.serverState();
  assert.equal(observed.stats.newJobs, 1);
  assert.equal(observed.jobs[0].sha256, createHash('sha256').update(f.expectedBytes).digest('hex'));
});

test('real DELETE 503 survives relaunch, retries the persisted key, and clears only after GET deleted', async t => {
  const f = await setup(t, 'delete_failure');
  const first = f.model({
    api: {
      ...f.api,
      async remove(jobId, deletionKey) {
        const saved = await f.freshStorage().load();
        assert.equal(saved.checkpoint.jobId, jobId);
        assert.equal(saved.deleteKey, deletionKey, 'delete intent must be committed before DELETE');
        assert.notEqual(saved.key, deletionKey, 'creation and deletion use separate random keys');
        return f.api.remove(jobId, deletionKey);
      },
    },
  });
  await first.activate();
  await first.confirm(f.file);
  await reachReady(first);
  const createdJobId = first.getSnapshot().operation.checkpoint.jobId;
  await first.deleteImport();

  const failed = first.getSnapshot();
  assert.equal(failed.phase, 'error');
  assert.ok(failed.error);
  assert.equal(failed.operation.checkpoint.status, 'ready');
  assert.notEqual(failed.job?.status, 'deleted');
  const deletionKey = failed.operation.deleteKey;
  assert.ok(deletionKey);
  assert.equal((await f.freshStorage().load()).deleteKey, deletionKey);
  const failureState = await f.serverState();
  assert.equal(failureState.stats.deleteRequests, 1);
  assert.equal(failureState.jobs[0].status, 'ready');

  first.deactivate();
  const restored = f.model();
  await restored.activate();
  assert.equal(restored.getSnapshot().operation.deleteKey, deletionKey);
  assert.equal(restored.getSnapshot().phase, 'error');
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1,
    'ordinary relaunch checks the saved intent without automatically deleting');

  await f.scenario('happy'); // Preserve jobs, keys and counters; do not reset.
  const beforeRetry = f.requests.length;
  await restored.retry();
  const retryRequests = f.requests.slice(beforeRetry);
  assert.equal(retryRequests[0].method, 'GET', 'retry checks current state first');
  const deletes = f.requests.filter(request => request.method === 'DELETE');
  assert.equal(deletes.length, 2);
  assert.deepEqual(deletes.map(request => request.idempotencyKey), [deletionKey, deletionKey]);
  assert.equal(restored.getSnapshot().phase, 'deleting', '202 is not completed deletion');
  assert.notEqual(restored.getSnapshot().job?.status, 'deleted');
  assert.equal((await f.freshStorage().load()).checkpoint.status, 'deleting');

  await reachDeleted(restored);
  assert.equal(restored.getSnapshot().operation, null);
  assert.equal(restored.getSnapshot().job.status, 'deleted');
  assert.equal(await f.freshStorage().load(), null);
  assert.deepEqual(await readFile(fileURLToPath(f.file.uri)), f.expectedBytes);
  assert.equal(f.files.list().some(name => name.startsWith('payload-')), false);
  const journal = f.files.list();
  assert.equal(journal.length, 1);
  const tombstone = await f.files.read(journal[0]);
  assert.deepEqual(JSON.parse(tombstone), { version: 1, cleared: true });
  assert.equal(tombstone.includes(key), false);
  assert.equal(tombstone.includes(deletionKey), false);
  const afterDelete = await f.serverState();
  assert.equal(afterDelete.stats.deleteRequests, 2);
  assert.equal(afterDelete.stats.newJobs, 1);
  assert.equal(afterDelete.jobs[0].status, 'deleted');

  await restored.newImport();
  assert.equal(restored.getSnapshot().phase, 'idle');
  assert.equal(restored.getSnapshot().job, null);
  restored.deactivate();
  const afterRelaunch = f.model();
  await afterRelaunch.activate();
  assert.equal(afterRelaunch.getSnapshot().phase, 'idle');
  assert.equal(afterRelaunch.getSnapshot().operation, null);
  await afterRelaunch.confirm(f.file);
  assert.notEqual(afterRelaunch.getSnapshot().operation.key, key);
  assert.notEqual(afterRelaunch.getSnapshot().operation.key, deletionKey);
  assert.notEqual(afterRelaunch.getSnapshot().operation.checkpoint.jobId, createdJobId);
  assert.equal((await f.serverState()).stats.newJobs, 2);
});

test('lost DELETE acknowledgement restores the committed intent and polls without another DELETE', async t => {
  const f = await setup(t, 'happy');
  let first;
  let deletionKey;
  first = f.model({
    api: {
      ...f.api,
      async remove(jobId, savedKey) {
        deletionKey = savedKey;
        assert.equal((await f.freshStorage().load()).deleteKey, savedKey);
        await f.api.remove(jobId, savedKey);
        // The origin committed deletion, but the app exits before seeing its ACK.
        first.deactivate();
        throw new Error('Simulated lost deletion acknowledgement');
      },
    },
  });
  await first.activate();
  await first.confirm(f.file);
  await reachReady(first);
  await first.deleteImport();
  const saved = await f.freshStorage().load();
  assert.equal(saved.deleteKey, deletionKey);
  assert.equal(saved.checkpoint.status, 'ready', 'lost ACK did not fabricate a deleting checkpoint');

  const restored = f.model({ createKey() { throw new Error('Recovery must keep the deletion key'); } });
  await restored.activate();
  assert.ok(['deleting', 'deleted'].includes(restored.getSnapshot().phase));
  await reachDeleted(restored);
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 1);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal((await f.serverState()).stats.deleteRequests, 1);
  assert.equal(await f.freshStorage().load(), null);
});

test('definitive first POST 415 survives relaunch and permits a different file with a fresh key', async t => {
  const f = await setup(t, 'happy');
  // The client sniffs CSV structure; the supplied mock accepts only its
  // comma-separated fixture schema. Do not alter the shared source fixtures.
  const rejectedBytes = Buffer.from('date;description;amount\n2026-10-01;StreamBeam;-19.99\n');
  const rejectedFile = await f.selection('semicolon.csv', rejectedBytes);
  assert.deepEqual(validateStatementContent(rejectedFile, rejectedBytes), { ok: true, format: 'csv' });
  let stagedUri;
  const first = f.model({
    api: {
      ...f.api,
      async create(operationKey, selected) {
        const saved = await f.freshStorage().load();
        assert.equal(saved.key, operationKey);
        assert.equal(saved.submission, 'pending', 'pending must be committed before the first POST');
        assert.equal(saved.rejectedStatus, undefined);
        stagedUri = selected.uri;
        assert.notEqual(stagedUri, rejectedFile.uri);
        assert.deepEqual(await readFile(fileURLToPath(stagedUri)), rejectedBytes);
        return f.api.create(operationKey, selected);
      },
    },
  });
  await first.activate();
  await first.confirm(rejectedFile);

  const rejected = first.getSnapshot();
  assert.equal(rejected.phase, 'error');
  assert.equal(rejected.operation.submission, 'rejected');
  assert.equal(rejected.operation.rejectedStatus, 415);
  assert.equal(rejected.operation.checkpoint, null);
  const rejectedKey = rejected.operation.key;
  assert.equal((await f.freshStorage().load()).rejectedStatus, 415);
  assert.equal((await f.serverState()).stats.newJobs, 0);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);

  first.deactivate();
  const restored = f.model();
  await restored.activate();
  assert.equal(restored.getSnapshot().operation.submission, 'rejected');
  assert.equal(restored.getSnapshot().operation.rejectedStatus, 415);
  assert.equal(restored.getSnapshot().operation.key, rejectedKey);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1,
    'a definitive rejection must not restart upload on relaunch');

  await restored.discardRejected();
  assert.equal(restored.getSnapshot().phase, 'idle');
  assert.equal(restored.getSnapshot().operation, null);
  assert.equal(restored.getSnapshot().job, null);
  assert.equal(await f.freshStorage().load(), null);
  assert.equal(existsSync(fileURLToPath(stagedUri)), false);
  assert.deepEqual(await readFile(fileURLToPath(rejectedFile.uri)), rejectedBytes,
    'discarding a rejected operation must preserve the selected source document');
  assert.equal(f.files.list().length, 1);
  assert.deepEqual(JSON.parse(await f.files.read(f.files.list()[0])), { version: 1, cleared: true });
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1,
    'choosing another file does not itself initiate upload');

  await restored.confirm(f.file);
  await reachReady(restored);
  assert.notEqual(restored.getSnapshot().operation.key, rejectedKey);
  assert.equal(restored.getSnapshot().job.items.reduce((sum, item) => sum + item.amountMinor, 0), 15199);
  const observed = await f.serverState();
  assert.equal(observed.stats.createRequests, 2);
  assert.equal(observed.stats.newJobs, 1, 'only the replacement file creates a server job');
  assert.equal(observed.stats.acceptedBytes, f.expectedBytes.length);
  assert.equal(observed.stats.deleteRequests, 0, 'an uncreated import needs no server DELETE');
  assert.equal(observed.jobs[0].sha256, createHash('sha256').update(f.expectedBytes).digest('hex'));
});
