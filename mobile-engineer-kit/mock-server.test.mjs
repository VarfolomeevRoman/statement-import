import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockServer } from './mock-server.mjs';

const csv = readFileSync(new URL('./fixtures/statement.csv', import.meta.url));
const pdf = readFileSync(new URL('./fixtures/statement.pdf', import.meta.url));

async function withServer(run) {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-hiring-mock-'));
  const server = createMockServer({ statePath: join(directory, 'state.json') });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

async function create(base, key = 'stable-key-001', body = csv) {
  return fetch(`${base}/imports`, {
    method: 'POST', headers: { 'Idempotency-Key': key, 'X-File-Name': 'statement.csv', 'Content-Type': 'application/octet-stream' }, body,
  });
}

async function mode(base, value) {
  const response = await fetch(`${base}/__test/scenario`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: value }),
  });
  assert.equal(response.status, 200);
}

test('same key and bytes produce one job; changed bytes conflict', async () => {
  await withServer(async base => {
    const first = await create(base);
    const second = await create(base);
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal((await first.json()).jobId, (await second.json()).jobId);
    assert.equal((await create(base, 'stable-key-001', Buffer.concat([csv, Buffer.from('extra')]))).status, 409);
    const state = await (await fetch(`${base}/__test/state`)).json();
    assert.equal(state.stats.newJobs, 1);
    assert.equal(state.stats.duplicateHits, 1);
  });
});

test('lost acknowledgement is recoverable by key', async () => {
  await withServer(async base => {
    await mode(base, 'lost_ack');
    await assert.rejects(create(base, 'stable-key-002'));
    const recovery = await fetch(`${base}/imports/by-key/stable-key-002`);
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json()).jobId, 'job-demo-001');
    const retry = await create(base, 'stable-key-002');
    assert.equal(retry.status, 202);
    assert.equal((await retry.json()).jobId, 'job-demo-001');
  });
});

test('stale status follows ready, and failed delete does not claim deletion', async () => {
  await withServer(async base => {
    const jobId = (await (await create(base, 'stable-key-003')).json()).jobId;
    await mode(base, 'stale_status');
    const first = await (await fetch(`${base}/imports/${jobId}`)).json();
    const stale = await (await fetch(`${base}/imports/${jobId}`)).json();
    assert.deepEqual([first.status, first.revision, stale.status, stale.revision], ['ready', 3, 'processing', 2]);
    await mode(base, 'delete_failure');
    const failed = await fetch(`${base}/imports/${jobId}`, { method: 'DELETE', headers: { 'Idempotency-Key': 'delete-key-003' } });
    assert.equal(failed.status, 503);
    const stillReady = await (await fetch(`${base}/imports/${jobId}`)).json();
    assert.notEqual(stillReady.status, 'deleted');
    await mode(base, 'happy');
    const accepted = await fetch(`${base}/imports/${jobId}`, { method: 'DELETE', headers: { 'Idempotency-Key': 'delete-key-003' } });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).status, 'deleting');
  });
});

test('rejects spoofed and oversized files', async () => {
  await withServer(async base => {
    assert.equal((await create(base, 'stable-key-004', Buffer.from('not a pdf'))).status, 415);
    assert.equal((await create(base, 'stable-key-005', Buffer.alloc(10 * 1024 * 1024 + 1, 65))).status, 413);
    const state = await (await fetch(`${base}/__test/state`)).json();
    assert.equal(state.stats.createRequests, 2);
    assert.equal(state.stats.newJobs, 0);
  });
});

test('accepts the shared PDF fixture as real bytes', async () => {
  await withServer(async base => {
    const response = await create(base, 'stable-key-pdf', pdf);
    assert.equal(response.status, 202);
    const state = await (await fetch(`${base}/__test/state`)).json();
    assert.equal(state.stats.acceptedBytes, pdf.length);
  });
});

test('job metadata survives a mock process restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-hiring-restart-'));
  const statePath = join(directory, 'state.json');
  let server = createMockServer({ statePath });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const jobId = (await (await create(base, 'stable-restart-key')).json()).jobId;
    await new Promise(resolve => server.close(resolve));
    server = createMockServer({ statePath });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const restored = await fetch(`http://127.0.0.1:${server.address().port}/imports/by-key/stable-restart-key`);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).jobId, jobId);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
