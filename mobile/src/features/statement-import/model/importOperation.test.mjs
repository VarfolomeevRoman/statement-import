import assert from 'node:assert/strict';
import test from 'node:test';
import { createImportOperation } from './importOperation.ts';
import { ImportApiError } from '../api/importApi.ts';

const file = { uri: 'file:///cache/copy', name: 'statement.csv', size: 112, format: 'csv' };
const queued = { jobId: 'job-demo-001', status: 'queued', revision: 1 };
const ready = { jobId: queued.jobId, status: 'ready', revision: 3, currency: 'AUD', items: [
  { id: 'rec-001', merchant: 'StreamBeam', amountMinor: 1999, cadence: 'monthly', lastSeen: '2026-10-01' },
  { id: 'rec-002', merchant: 'BrightGrid', amountMinor: 13200, cadence: 'monthly', lastSeen: '2026-10-03' },
] };
const key = 'stable-random-key';
const deleting = { jobId: queued.jobId, status: 'deleting', revision: 4 };
const deleted = { jobId: queued.jobId, status: 'deleted', revision: 5 };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const events = [];
  let disk = null;
  let keys = 0;
  const storage = {
    async load() { events.push('load'); return structuredClone(disk); },
    async stage(f, k) { events.push('stage'); return { ...f, uri: `file:///private/${k}` }; },
    async save(op) { events.push('save'); disk = structuredClone(op); },
    async removePayload() { events.push('remove'); },
    async clear(k) {
      events.push('clear');
      assert.equal(disk.key, k);
      assert.ok(disk.checkpoint?.status === 'deleted' || disk.submission === 'rejected');
      disk = null;
    },
  };
  const api = {
    async create(k, f) { events.push(['POST', k, f.uri]); return queued; },
    async findByKey(k) { events.push(['by-key', k]); return ready; },
    async get(id) { events.push(['GET', id]); return ready; },
    async remove(id, k) { events.push(['DELETE', id, k]); return deleting; },
  };
  const timers = [];
  const deps = { api, storage, createKey: () => keys++ === 0 ? key : `${key}-${keys}`, schedule: callback => {
    const timer = { callback, canceled: false };
    timers.push(timer);
    return () => { timer.canceled = true; };
  } };
  const model = createImportOperation(deps);
  return { model, deps, api, storage, events, timers, getDisk: () => disk, setDisk: value => { disk = value; } };
}

test('confirmation persists random key and durable bytes before POST; ready comes from GET', async () => {
  const s = setup();
  await s.model.activate();
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'POST'), false);
  let sent;
  s.api.create = async (k, f) => {
    sent = { k, f, disk: structuredClone(s.getDisk()), events: [...s.events] };
    return queued;
  };
  s.api.get = async () => {
    assert.equal(s.model.getSnapshot().job.status, 'queued');
    return ready;
  };
  await s.model.confirm(file);
  assert.equal(sent.disk.key, sent.k);
  assert.equal(sent.disk.file.uri, sent.f.uri);
  assert.equal(sent.disk.submission, 'pending');
  assert.deepEqual(sent.events, ['load', 'stage', 'save', 'save']);
  assert.notEqual(sent.f.uri, file.uri);
  assert.equal(s.model.getSnapshot().phase, 'ready');
  assert.equal(s.model.getSnapshot().job.items.reduce((sum, item) => sum + item.amountMinor, 0), 15199);
  assert.equal(s.getDisk().file, null);
  assert.deepEqual(Object.keys(s.getDisk().checkpoint).sort(), ['jobId', 'revision', 'status']);
  assert.ok(s.events.indexOf('save') < s.events.indexOf('remove'));
});

test('failed local commit prevents POST and blocks another key until reload', async () => {
  const s = setup();
  await s.model.activate();
  s.storage.save = async () => { throw new Error('private/path'); };
  await s.model.confirm(file);
  await s.model.confirm(file);
  assert.equal(s.model.getSnapshot().storageBlocked, true);
  assert.equal(s.events.filter(e => Array.isArray(e) && e[0] === 'POST').length, 0);
  assert.equal(s.events.filter(e => e === 'stage').length, 1);
  assert.doesNotMatch(s.model.getSnapshot().error, /private/);
});

test('lost acknowledgement looks up the saved key and never creates a second job', async () => {
  const s = setup();
  await s.model.activate();
  let posts = 0;
  s.api.create = async () => { posts++; throw new Error('Connection dropped'); };
  await s.model.confirm(file);
  assert.equal(posts, 1);
  assert.ok(s.events.some(e => Array.isArray(e) && e[0] === 'by-key' && e[1] === key));
  assert.equal(s.model.getSnapshot().phase, 'ready');
});

test('404 after lost response keeps payload; only explicit retry POSTs same key and bytes', async () => {
  const s = setup();
  await s.model.activate();
  const sent = [];
  s.api.create = async (k, f) => { sent.push({ k, f }); if (sent.length === 1) throw new Error('lost'); return queued; };
  s.api.findByKey = async () => null;
  await s.model.confirm(file);
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.getDisk().file.size, 112);
  await s.model.refresh();
  assert.equal(sent.length, 1);
  await s.model.retry();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(s.model.getSnapshot().phase, 'ready');
});

test('cold relaunch recovers by key without POST even when lookup returns 404', async () => {
  const s = setup();
  s.setDisk({ version: 1, key, file, checkpoint: null });
  s.api.findByKey = async () => null;
  await s.model.activate();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'POST'), false);
  s.api.findByKey = async () => ready;
  await s.model.refresh();
  assert.equal(s.model.getSnapshot().phase, 'ready');
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'POST'), false);
});

test('relaunch uses saved job ID; missing local payload is not uploaded again', async () => {
  const s = setup();
  s.setDisk({ version: 1, key, file: null, checkpoint: { ...queued } });
  await s.model.activate();
  assert.equal(s.model.getSnapshot().phase, 'ready');
  assert.ok(s.events.some(e => Array.isArray(e) && e[0] === 'GET'));
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'POST'), false);
});

test('older revision and higher-revision status regression cannot replace ready', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  for (const revision of [2, 4]) {
    s.api.get = async () => ({ ...queued, status: 'processing', revision });
    await s.model.refresh();
    assert.equal(s.model.getSnapshot().job.status, 'ready');
    assert.equal(s.getDisk().checkpoint.revision, 3);
  }
});

test('two confirmation taps share one operation and poll waits for an authoritative GET', async () => {
  const s = setup();
  await s.model.activate();
  const pending = deferred();
  s.api.create = () => pending.promise;
  s.api.get = async () => ({ ...queued, status: 'processing', revision: 2 });
  const first = s.model.confirm(file);
  await s.model.confirm(file);
  pending.resolve(queued);
  await first;
  assert.equal(s.events.filter(e => e === 'stage').length, 1);
  assert.equal(s.model.getSnapshot().phase, 'waiting');
  assert.equal(s.timers.filter(t => !t.canceled).length, 1);
  s.model.deactivate();
  assert.equal(s.timers.filter(t => !t.canceled).length, 0);
});

test('late create response after deactivation cannot mutate UI; activation restores by saved key', async () => {
  const s = setup();
  await s.model.activate();
  const pending = deferred();
  s.api.create = () => pending.promise;
  const first = s.model.confirm(file);
  while (!s.getDisk()) await Promise.resolve();
  await Promise.resolve();
  s.model.deactivate();
  const second = s.model.activate();
  pending.resolve(queued);
  await Promise.all([first, second]);
  assert.equal(s.model.getSnapshot().phase, 'ready');
  assert.ok(s.events.some(e => Array.isArray(e) && e[0] === 'by-key'));
});

test('payload cleanup failure retains operation and retry does GET without POST', async () => {
  const s = setup();
  await s.model.activate();
  s.storage.removePayload = async () => { throw new Error('disk/private'); };
  await s.model.confirm(file);
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.getDisk().checkpoint.jobId, queued.jobId);
  s.storage.removePayload = async () => {};
  await s.model.retry();
  assert.equal(s.model.getSnapshot().phase, 'ready');
  assert.equal(s.events.filter(e => Array.isArray(e) && e[0] === 'POST').length, 1);
  assert.equal(s.getDisk().file, null);
});

test('a restored deleted checkpoint cannot be resurrected by a late ready response', async () => {
  const s = setup();
  s.setDisk({ version: 1, key, file: null, checkpoint: { ...queued, status: 'deleted', revision: 5 } });
  s.api.get = async () => ({ ...queued, status: 'deleted', revision: 5 });
  await s.model.activate();
  s.api.get = async () => ready;
  await s.model.refresh();
  assert.equal(s.model.getSnapshot().job.status, 'deleted');
  assert.equal(s.model.getSnapshot().phase, 'deleted');
  assert.equal(s.getDisk(), null);
});

test('deletion persists a separate key before DELETE and 202 cannot claim completion', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  const pending = deferred();
  s.api.remove = async (id, deleteKey) => {
    assert.notEqual(deleteKey, key);
    assert.equal(s.getDisk().deleteKey, deleteKey);
    assert.equal(s.getDisk().checkpoint.status, 'ready');
    assert.equal(id, queued.jobId);
    return deleting;
  };
  s.api.get = () => pending.promise;
  const work = s.model.deleteImport();
  while (s.getDisk().checkpoint.status !== 'deleting') await Promise.resolve();
  assert.equal(s.model.getSnapshot().phase, 'deleting');
  assert.ok(s.getDisk());
  pending.resolve(deleting);
  await work;
  assert.equal(s.model.getSnapshot().phase, 'deleting');
  assert.equal(s.timers.filter(t => !t.canceled).length, 1);
  s.api.get = async () => deleted;
  await s.model.refresh();
  assert.equal(s.model.getSnapshot().phase, 'deleted');
  assert.equal(s.model.getSnapshot().operation, null);
  assert.equal(s.model.getSnapshot().job.status, 'deleted');
  assert.equal(s.getDisk(), null);
  await s.model.newImport();
  assert.equal(s.model.getSnapshot().phase, 'idle');
  assert.equal(s.model.getSnapshot().job, null);
});

test('failed save before DELETE prevents the request and does not claim deletion', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  s.storage.save = async () => { throw new Error('private/path'); };
  await s.model.deleteImport();
  assert.equal(s.model.getSnapshot().storageBlocked, true);
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'DELETE'), false);
  assert.equal(s.getDisk().checkpoint.status, 'ready');
  assert.equal(s.getDisk().deleteKey, undefined);
});

test('failed DELETE retains its key; retry reconciles first and reuses that key', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  const attempts = [];
  s.api.remove = async (id, k) => {
    attempts.push({ id, k });
    if (attempts.length === 1) throw new Error('503 private response');
    return deleting;
  };
  await s.model.deleteImport();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.getDisk().checkpoint.status, 'ready');
  assert.equal(s.getDisk().deleteKey, attempts[0].k);
  assert.doesNotMatch(s.model.getSnapshot().error, /private/);
  await s.model.newImport();
  assert.equal(s.model.getSnapshot().phase, 'error');
  await s.model.refresh(); // Automatic reconciliation cannot repeat DELETE.
  assert.equal(attempts.length, 1);
  await s.model.retry();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  // A stale ready response following deleting does not roll the state back.
  assert.equal(s.model.getSnapshot().phase, 'deleting');
  assert.equal(s.getDisk().checkpoint.revision, 4);
});

test('relaunch keeps deletion intent but never initiates another DELETE', async () => {
  const s = setup();
  s.setDisk({ version: 1, key, file: null, checkpoint: { jobId: queued.jobId, status: 'ready', revision: 3 }, deleteKey: 'persisted-delete-key' });
  await s.model.activate();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.model.getSnapshot().operation.deleteKey, 'persisted-delete-key');
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'DELETE'), false);
  s.api.get = async () => deleting;
  await s.model.retry();
  assert.equal(s.model.getSnapshot().phase, 'deleting');
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'DELETE'), false);
});

test('even 202/deleted waits for authoritative GET; GET failure retains recovery state', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  s.api.remove = async () => deleted;
  s.api.get = async () => { throw new Error('offline'); };
  await s.model.deleteImport();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.getDisk().checkpoint.status, 'ready');
  assert.equal(s.events.includes('clear'), false);
  s.api.get = async () => deleted;
  await s.model.retry();
  assert.equal(s.model.getSnapshot().phase, 'deleted');
});

test('local cleanup failure after deleted blocks a new import; retry cleans without network', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  const clear = s.storage.clear;
  s.storage.clear = async () => { throw new Error('filesystem'); };
  s.api.get = async () => deleted;
  await s.model.deleteImport();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.getDisk().checkpoint.status, 'deleted');
  await s.model.newImport();
  assert.equal(s.model.getSnapshot().phase, 'error');
  s.storage.clear = clear;
  s.api.get = async () => { throw new Error('must not call GET'); };
  s.api.remove = async () => { throw new Error('must not call DELETE'); };
  await s.model.retry();
  assert.equal(s.model.getSnapshot().phase, 'deleted');
  assert.equal(s.getDisk(), null);
});

test('double delete confirmation cannot create two requests or keys', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  const pending = deferred();
  let count = 0;
  s.api.remove = async () => { count++; return pending.promise; };
  const first = s.model.deleteImport();
  await s.model.deleteImport();
  pending.resolve(deleting);
  await first;
  assert.equal(count, 1);
  assert.equal(s.getDisk().deleteKey, `${key}-2`);
});

test('late response from a previous activation cannot resurrect an already deleted operation', async () => {
  const s = setup();
  await s.model.activate();
  await s.model.confirm(file);
  const pending = deferred();
  s.api.get = () => pending.promise;
  const oldRequest = s.model.refresh();
  s.model.deactivate();
  s.setDisk({ version: 1, key, file: null, checkpoint: deleted, deleteKey: 'saved-delete-key' });
  const resumed = s.model.activate();
  pending.resolve(ready);
  await Promise.all([oldRequest, resumed]);
  assert.equal(s.model.getSnapshot().phase, 'deleted');
  assert.equal(s.model.getSnapshot().job.status, 'deleted');
  assert.equal(s.getDisk(), null);
});

test('failed picker cache cleanup retains the deleted checkpoint until cleanup can be retried', async () => {
  const s = setup();
  s.setDisk({ version: 1, key, file: null, checkpoint: deleted, deleteKey: 'saved-delete-key' });
  let failed = true;
  s.deps.clearSelectionCache = async () => { if (failed) throw new Error('cache inaccessible'); };
  await s.model.activate();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.events.includes('clear'), false);
  assert.equal(s.getDisk().checkpoint.status, 'deleted');
  failed = false;
  await s.model.retry();
  assert.equal(s.model.getSnapshot().phase, 'deleted');
  assert.equal(s.getDisk(), null);
});

function rejected(status) {
  return new ImportApiError('Safe server rejection', { outcome: 'rejected', retryable: false, status });
}

test('first explicit format rejection persists, can be discarded, and never uploads on replacement', async () => {
  const s = setup();
  await s.model.activate();
  s.api.create = async () => { throw rejected(415); };
  await s.model.confirm(file);
  assert.equal(s.getDisk().submission, 'rejected');
  assert.equal(s.getDisk().rejectedStatus, 415);
  assert.equal(s.getDisk().checkpoint, null);
  assert.equal(s.model.getSnapshot().phase, 'error');
  await s.model.retry();
  assert.equal(s.getDisk().submission, 'rejected');
  await s.model.discardRejected();
  assert.equal(s.model.getSnapshot().phase, 'idle');
  assert.equal(s.model.getSnapshot().operation, null);
  assert.equal(s.getDisk(), null);
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'DELETE'), false);
});

test('relaunch of terminal rejection shows safe error without repeating POST or requiring network', async () => {
  const s = setup();
  s.setDisk({ version: 1, key, file, checkpoint: null, submission: 'rejected', rejectedStatus: 413 });
  let lookups = 0;
  s.api.findByKey = async () => { lookups++; throw new Error('offline'); };
  await s.model.activate();
  assert.equal(s.model.getSnapshot().operation.rejectedStatus, 413);
  assert.match(s.model.getSnapshot().error, /размер/);
  assert.equal(lookups, 0);
  await s.model.discardRejected();
  assert.equal(s.getDisk(), null);
});

test('failure to persist pending marker prevents even the first HTTP attempt', async () => {
  const s = setup();
  const save = s.storage.save;
  s.storage.save = async op => {
    if (op.submission === 'pending') throw new Error('disk');
    await save(op);
  };
  await s.model.activate();
  await s.model.confirm(file);
  assert.equal(s.model.getSnapshot().storageBlocked, true);
  assert.equal(s.getDisk().submission, 'prepared');
  assert.equal(s.events.some(e => Array.isArray(e) && e[0] === 'POST'), false);
  await s.model.discardRejected();
  assert.ok(s.getDisk());
});

test('failure to persist rejection does not enable discard until a committed rejection is recovered', async () => {
  const s = setup();
  const save = s.storage.save;
  s.storage.save = async op => {
    if (op.submission === 'rejected') throw new Error('disk');
    await save(op);
  };
  s.api.create = async () => { throw rejected(415); };
  await s.model.activate();
  await s.model.confirm(file);
  assert.equal(s.getDisk().submission, 'pending');
  assert.equal(s.model.getSnapshot().storageBlocked, true);
  await s.model.discardRejected();
  assert.ok(s.getDisk());
});

test('unknown first outcome followed by a rejected retry cannot discard the original key', async () => {
  const s = setup();
  let count = 0;
  s.api.create = async () => { if (++count === 1) throw new Error('lost ACK'); throw rejected(415); };
  s.api.findByKey = async () => null;
  await s.model.activate();
  await s.model.confirm(file);
  await s.model.retry();
  assert.equal(count, 2);
  assert.equal(s.getDisk().submission, 'pending');
  assert.equal(s.getDisk().key, key);
  await s.model.discardRejected();
  assert.ok(s.getDisk());
  assert.equal(s.events.includes('clear'), false);
});

test('legacy or interrupted upload remains ambiguous after 415 on retry', async () => {
  for (const marker of [undefined, 'pending']) {
    const s = setup();
    s.setDisk({ version: 1, key, file, checkpoint: null, ...(marker ? { submission: marker } : {}) });
    s.api.findByKey = async () => null;
    s.api.create = async () => { throw rejected(415); };
    await s.model.activate();
    await s.model.retry();
    assert.equal(s.getDisk().submission, 'pending');
    await s.model.discardRejected();
    assert.ok(s.getDisk());
  }
});

test('generic rejection, conflict, rate limit and server/network errors never enable discard', async () => {
  for (const status of [400, 409, 429, 503, 408]) {
    const s = setup();
    s.api.findByKey = async () => null;
    s.api.create = async () => { throw new ImportApiError('Safe error', {
      outcome: status < 500 && status !== 408 ? 'rejected' : 'unknown', retryable: true, status,
    }); };
    await s.model.activate();
    await s.model.confirm(file);
    await s.model.discardRejected();
    assert.equal(s.getDisk().key, key);
    assert.equal(s.getDisk().submission, 'pending');
    assert.equal(s.events.includes('clear'), false);
  }
});

test('rejected-file cleanup failure preserves operation and can be retried', async () => {
  const s = setup();
  s.api.create = async () => { throw rejected(415); };
  await s.model.activate();
  await s.model.confirm(file);
  const clear = s.storage.clear;
  s.storage.clear = async () => { throw new Error('disk failure'); };
  await s.model.discardRejected();
  assert.equal(s.model.getSnapshot().phase, 'error');
  assert.equal(s.getDisk().submission, 'rejected');
  s.storage.clear = clear;
  await s.model.discardRejected();
  assert.equal(s.model.getSnapshot().phase, 'idle');
  assert.equal(s.getDisk(), null);
});
