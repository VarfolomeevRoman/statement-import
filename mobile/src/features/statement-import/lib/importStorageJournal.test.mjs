import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, copyFile, rename, rm, open } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createImportStorageJournal } from './importStorageJournal.ts';

const key = '00000000-0000-4000-8000-000000000001';
const checkpoint = { jobId: 'job-demo-001', status: 'processing', revision: 2 };
const csv = 'date,description,amount\n2026-10-01,StreamBeam,19.99\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'statement-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let directory = join(root, 'documents');
  let failCommit = false;
  let partialWrite = false;
  let failCleanup = false;
  const sourcePath = join(root, 'selected.csv');
  await writeFile(sourcePath, csv);
  const file = { uri: pathToFileURL(sourcePath).href, name: 'Тест.csv', size: Buffer.byteLength(csv), format: 'csv' };
  const files = {
    ensure() { mkdirSync(directory, { recursive: true }); },
    list() { return readdirSync(directory); },
    uri(name) { return pathToFileURL(join(directory, name)).href; },
    exists(name) { return existsSync(join(directory, name)); },
    size(name) { return statSync(join(directory, name)).size; },
    read(name) { return readFile(join(directory, name), 'utf8'); },
    async writeExclusive(name, content) {
      const handle = await open(join(directory, name), 'wx');
      try {
        await handle.writeFile(partialWrite ? content.slice(0, 30) : content);
        if (partialWrite) throw new Error('private path must not escape');
      } finally { await handle.close(); }
    },
    async copyFrom(source, name) { await copyFile(fileURLToPath(source.uri), join(directory, name), 1); },
    async commit(temporary, destination) {
      if (failCommit) throw new Error('private path must not escape');
      assert.equal(existsSync(join(directory, destination)), false);
      await rename(join(directory, temporary), join(directory, destination));
    },
    async remove(name) {
      if (failCleanup) throw new Error('private path must not escape');
      await rm(join(directory, name), { force: true });
    },
  };
  return {
    file, files,
    storage: createImportStorageJournal(files),
    failCommit(value) { failCommit = value; },
    partialWrite(value) { partialWrite = value; },
    failCleanup(value) { failCleanup = value; },
    async relocate() {
      const destination = join(root, 'relocated-documents');
      await rename(directory, destination);
      directory = destination;
    },
  };
}

async function prepared(f) {
  const file = await f.storage.stage(f.file, key);
  return { version: 1, key, file, checkpoint: null };
}

test('committed operation survives a fresh store and container relocation without saving absolute URI or report', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
  const manifest = await f.files.read(f.files.list().find(name => name.endsWith('.json')));
  assert.equal(manifest.includes('file://'), false);
  assert.equal(manifest.includes('StreamBeam'), false);
  await f.relocate();
  const restored = await createImportStorageJournal(f.files).load();
  assert.equal(restored.key, key);
  assert.equal(restored.file.name, 'Тест.csv');
  assert.notEqual(restored.file.uri, operation.file.uri);
  assert.equal(await readFile(fileURLToPath(restored.file.uri), 'utf8'), csv);
});

test('interrupted commit preserves the previous key and revision, and a fresh store removes incomplete temp', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  f.failCommit(true);
  await assert.rejects(f.storage.save({ ...operation, checkpoint }), { message: 'Import storage unavailable' });
  assert.ok(f.files.list().some(name => name.endsWith('.tmp')));
  const restored = await createImportStorageJournal(f.files).load();
  assert.equal(restored.key, key);
  assert.equal(restored.checkpoint, null);
  assert.equal(f.files.list().some(name => name.endsWith('.tmp')), false);
  assert.equal(existsSync(fileURLToPath(restored.file.uri)), true);
});

test('an interrupted first write was never committed and only its orphan app copy is removed on restart', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  f.partialWrite(true);
  await assert.rejects(f.storage.save(operation));
  assert.equal(await createImportStorageJournal(f.files).load(), null);
  assert.deepEqual(f.files.list(), []);
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
});

test('corrupt newest committed snapshot fails closed without fallback or deleting recoverable payload', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  await f.storage.save({ ...operation, checkpoint });
  const latest = f.files.list().filter(name => name.endsWith('.json')).sort().at(-1);
  await writeFile(fileURLToPath(f.files.uri(latest)), '{broken');
  await assert.rejects(createImportStorageJournal(f.files).load(), { message: 'Import storage unavailable' });
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), true);
  await assert.rejects(f.storage.save(operation));
});

test('commit compaction keeps two pending snapshots, then removes bytes and all historical filenames', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  await f.storage.save({ ...operation, checkpoint });
  await f.storage.save({ ...operation, checkpoint: { ...checkpoint, status: 'ready', revision: 3 } });
  assert.equal(f.files.list().filter(name => name.endsWith('.json')).length, 2);
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), true);
  await f.storage.save({ ...operation, file: null, checkpoint: { ...checkpoint, status: 'ready', revision: 3 } });
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), false);
  const retained = f.files.list().filter(name => name.endsWith('.json'));
  assert.equal(retained.length, 1);
  for (const name of retained) {
    const content = await f.files.read(name);
    assert.equal(content.includes(operation.file.name), false);
    assert.equal(content.includes('"payload"'), false);
  }
  assert.equal((await createImportStorageJournal(f.files).load()).file, null);
  assert.equal(existsSync(fileURLToPath(f.file.uri)), true);
});

test('cleanup failure does not reject an already committed operation and is retried on load', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  f.failCleanup(true);
  const accepted = { ...operation, file: null, checkpoint };
  await f.storage.save(accepted);
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), true);
  f.failCleanup(false);
  assert.deepEqual(await createImportStorageJournal(f.files).load(), accepted);
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), false);
});

test('missing bytes preserve the key for recovery and cannot be committed as a fresh upload', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  await f.storage.removePayload(operation.file);
  assert.equal((await createImportStorageJournal(f.files).load()).key, key);
  await assert.rejects(f.storage.save(operation));
  await f.storage.save({ ...operation, checkpoint });
  assert.equal((await createImportStorageJournal(f.files).load()).checkpoint.jobId, checkpoint.jobId);
});

test('journal rejects another key, revision rollback, path traversal, and deletion of source documents', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save({ ...operation, checkpoint });
  await assert.rejects(f.storage.save({ ...operation, checkpoint, key: `${key}x` }));
  await assert.rejects(f.storage.save({ ...operation, checkpoint: { ...checkpoint, revision: 1 } }));
  await assert.rejects(f.storage.stage(f.file, '../malicious-key'));
  await assert.rejects(f.storage.removePayload(f.file));
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
});

test('same-key staging cannot replace immutable bytes and mismatch is cleaned without changing the source', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await assert.rejects(f.storage.stage(f.file, key));
  assert.equal(await readFile(fileURLToPath(operation.file.uri), 'utf8'), csv);
  await assert.rejects(f.storage.stage({ ...f.file, size: f.file.size + 1 }, `${key}x`));
  assert.equal(f.files.list().some(name => name.includes(`${key}x`)), false);
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
});

test('delete key survives a fresh store and cannot be dropped, changed, or saved without a known job', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation); // Old records without deleteKey remain valid.
  assert.equal((await createImportStorageJournal(f.files).load()).deleteKey, undefined);
  await assert.rejects(f.storage.save({ ...operation, deleteKey: 'delete-key-stable' }));
  await assert.rejects(f.storage.save({ ...operation, checkpoint, deleteKey: '../unsafe-key' }));
  const deleting = { ...operation, checkpoint, deleteKey: 'delete-key-stable' };
  await f.storage.save(deleting);
  assert.deepEqual(await createImportStorageJournal(f.files).load(), deleting);
  await assert.rejects(f.storage.save({ ...operation, checkpoint }));
  await assert.rejects(f.storage.save({ ...deleting, deleteKey: 'delete-key-another' }));
  assert.equal((await f.storage.load()).deleteKey, 'delete-key-stable');
});

test('clear requires confirmed deleted and commits an empty tombstone before allowing a new import', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save({ ...operation, checkpoint });
  await assert.rejects(f.storage.clear(key));
  const deleted = { ...operation, deleteKey: 'delete-key-stable', checkpoint: { ...checkpoint, status: 'deleted', revision: 5 } };
  await f.storage.save(deleted);
  await assert.rejects(f.storage.clear('wrong-import-key'));
  await f.storage.clear(key);
  assert.equal(await createImportStorageJournal(f.files).load(), null);
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), false);
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
  assert.equal(f.files.list().length, 1);
  assert.deepEqual(JSON.parse(await f.files.read(f.files.list()[0])), { version: 1, cleared: true });
  await f.storage.clear(key); // Idempotent after the data-free tombstone.
  await assert.rejects(f.storage.save(deleted), 'late checkpoint cannot resurrect an old import');
  const newKey = '00000000-0000-4000-8000-000000000002';
  const newFile = await f.storage.stage(f.file, newKey);
  await f.storage.save({ version: 1, key: newKey, file: newFile, checkpoint: null });
  assert.equal((await createImportStorageJournal(f.files).load()).key, newKey);
});

test('interrupted tombstone commit preserves deleted checkpoint for cleanup retry after restart', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  const deleted = { ...operation, deleteKey: 'delete-key-stable', checkpoint: { ...checkpoint, status: 'deleted', revision: 5 } };
  await f.storage.save(deleted);
  f.failCommit(true);
  await assert.rejects(f.storage.clear(key));
  assert.equal((await createImportStorageJournal(f.files).load()).checkpoint.status, 'deleted');
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), true);
  f.failCommit(false);
  await createImportStorageJournal(f.files).clear(key);
  assert.equal(await f.storage.load(), null);
});

test('failed cleanup after tombstone cannot resurrect result or claim local cleanup until retried', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  const deleted = { ...operation, deleteKey: 'delete-key-stable', checkpoint: { ...checkpoint, status: 'deleted', revision: 5 } };
  await f.storage.save(deleted);
  f.failCleanup(true);
  await assert.rejects(f.storage.clear(key));
  const newest = f.files.list().filter(name => name.endsWith('.json')).sort().at(-1);
  assert.deepEqual(JSON.parse(await f.files.read(newest)), { version: 1, cleared: true });
  await assert.rejects(createImportStorageJournal(f.files).load());
  await assert.rejects(f.storage.clear(key));
  await assert.rejects(f.storage.stage(f.file, 'new-import-key'));
  f.failCleanup(false);
  assert.equal(await createImportStorageJournal(f.files).load(), null);
  assert.equal(f.files.list().length, 1);
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), false);
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
});

test('legacy records stay unknown and cannot be reclassified as prepared or terminally rejected', async t => {
  const f = await fixture(t);
  const operation = await prepared(f);
  await f.storage.save(operation);
  const restored = await createImportStorageJournal(f.files).load();
  assert.equal(restored.submission, undefined);
  assert.equal(restored.rejectedStatus, undefined);
  await assert.rejects(f.storage.save({ ...operation, submission: 'prepared' }));
  await assert.rejects(f.storage.save({ ...operation, submission: 'rejected', rejectedStatus: 415 }));
  await assert.rejects(f.storage.clear(key));
  assert.deepEqual(await f.storage.load(), operation);
  // A legacy operation can still be retried safely or recovered to a known job.
  await f.storage.save({ ...operation, submission: 'pending' });
  await f.storage.save({ ...operation, checkpoint });
  assert.equal((await f.storage.load()).checkpoint.jobId, checkpoint.jobId);
});

test('prepared and pending submissions survive restart but never authorize local discard', async t => {
  const f = await fixture(t);
  const operation = { ...await prepared(f), submission: 'prepared' };
  await f.storage.save(operation);
  assert.deepEqual(await createImportStorageJournal(f.files).load(), operation);
  await assert.rejects(f.storage.clear(key));
  await assert.rejects(f.storage.save({ ...operation, submission: 'rejected', rejectedStatus: 413 }));
  const pending = { ...operation, submission: 'pending' };
  await f.storage.save(pending);
  assert.deepEqual(await createImportStorageJournal(f.files).load(), pending);
  await assert.rejects(f.storage.clear(key));
  await assert.rejects(f.storage.save(operation));
  await assert.rejects(f.storage.save({ ...pending, submission: undefined }));
  assert.deepEqual(await f.storage.load(), pending);
  assert.equal(existsSync(fileURLToPath(operation.file.uri)), true);
});

test('committed definitive rejection survives restart, clears only its own payload, and permits a new key', async t => {
  for (const rejectedStatus of [413, 415]) {
    const f = await fixture(t);
    const operation = { ...await prepared(f), submission: 'prepared' };
    await f.storage.save(operation);
    await f.storage.save({ ...operation, submission: 'pending' });
    const rejected = { ...operation, submission: 'rejected', rejectedStatus };
    await f.storage.save(rejected);
    assert.deepEqual(await createImportStorageJournal(f.files).load(), rejected);
    await assert.rejects(f.storage.clear('another-key'));
    await f.storage.clear(key);
    assert.equal(await createImportStorageJournal(f.files).load(), null);
    assert.equal(existsSync(fileURLToPath(operation.file.uri)), false);
    assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
    assert.equal(f.files.list().length, 1);
    assert.deepEqual(JSON.parse(await f.files.read(f.files.list()[0])), { version: 1, cleared: true });
    await assert.rejects(f.storage.save(rejected), 'cleared rejected metadata cannot resurrect the old operation');
    const newKey = 'replacement-operation-key';
    const newFile = await f.storage.stage(f.file, newKey);
    await f.storage.save({ version: 1, key: newKey, file: newFile, checkpoint: null, submission: 'prepared' });
    assert.equal((await f.storage.load()).key, newKey);
  }
});

test('terminal rejection cannot be reset to pending, lose its status, or switch rejection reason', async t => {
  const f = await fixture(t);
  const operation = { ...await prepared(f), submission: 'prepared' };
  await assert.rejects(f.storage.save({ ...operation, submission: 'rejected', rejectedStatus: 415 }));
  await f.storage.save(operation);
  await f.storage.save({ ...operation, submission: 'pending' });
  const rejected = { ...operation, submission: 'rejected', rejectedStatus: 415 };
  await f.storage.save(rejected);
  await assert.rejects(f.storage.save({ ...operation, submission: 'pending' }));
  await assert.rejects(f.storage.save(operation));
  await assert.rejects(f.storage.save({ ...rejected, submission: undefined, rejectedStatus: undefined }));
  await assert.rejects(f.storage.save({ ...rejected, rejectedStatus: 413 }));
  assert.deepEqual(await f.storage.load(), rejected);
});

test('journal rejects corrupt or contradictory persisted submission and rejection fields', async t => {
  const f = await fixture(t);
  const operation = { ...await prepared(f), submission: 'prepared' };
  await f.storage.save(operation);
  const name = f.files.list().find(name => name.endsWith('.json'));
  const original = JSON.parse(await f.files.read(name));
  for (const invalid of [
    { submission: 'unknown-value' },
    { submission: 'pending', rejectedStatus: 415 },
    { submission: undefined, rejectedStatus: 415 },
    { submission: 'rejected' },
    { submission: 'rejected', rejectedStatus: 409 },
    { submission: 'rejected', rejectedStatus: 400 },
    { submission: 'rejected', rejectedStatus: '415' },
    { submission: 'rejected', rejectedStatus: 415, checkpoint },
    { submission: 'prepared', checkpoint },
    { submission: 'rejected', rejectedStatus: 415, deleteKey: 'some-delete-key' },
  ]) {
    await writeFile(fileURLToPath(f.files.uri(name)), JSON.stringify({ ...original, ...invalid }));
    await assert.rejects(createImportStorageJournal(f.files).load(), { message: 'Import storage unavailable' });
    assert.equal(existsSync(fileURLToPath(operation.file.uri)), true);
  }
});

test('rejected state can be persisted without bytes; interrupted clear and failed cleanup remain retryable', async t => {
  const f = await fixture(t);
  const operation = { ...await prepared(f), submission: 'prepared' };
  await f.storage.save(operation);
  await f.storage.save({ ...operation, submission: 'pending' });
  await f.storage.removePayload(operation.file);
  const rejected = { ...operation, submission: 'rejected', rejectedStatus: 415 };
  await f.storage.save(rejected);
  f.failCommit(true);
  await assert.rejects(f.storage.clear(key));
  assert.deepEqual(await createImportStorageJournal(f.files).load(), rejected);
  f.failCommit(false);
  f.failCleanup(true);
  await assert.rejects(f.storage.clear(key));
  await assert.rejects(createImportStorageJournal(f.files).load());
  const latest = f.files.list().filter(name => name.endsWith('.json')).sort().at(-1);
  assert.deepEqual(JSON.parse(await f.files.read(latest)), { version: 1, cleared: true });
  f.failCleanup(false);
  assert.equal(await createImportStorageJournal(f.files).load(), null);
  assert.equal(f.files.list().length, 1);
  assert.equal(await readFile(fileURLToPath(f.file.uri), 'utf8'), csv);
});
