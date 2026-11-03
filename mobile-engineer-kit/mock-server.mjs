import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const defaultStatePath = join(directory, '.mock-state.json');
const maximumBytes = 10 * 1024 * 1024;
const modes = new Set(['happy', 'lost_ack', 'stale_status', 'delete_failure']);

function freshState() {
  return {
    mode: 'happy', nextJobId: 1, jobs: {}, byKey: {}, deleteKeys: {}, getCounts: {},
    stats: { createRequests: 0, newJobs: 0, duplicateHits: 0, acceptedBytes: 0, deleteRequests: 0 },
  };
}

function readState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return freshState(); throw error; }
}

function saveState(path, state) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, path);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error('payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function format(bytes) {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (bytes.subarray(0, 24).toString('utf8').replace(/\r/g, '').startsWith('date,description,amount\n')) return 'csv';
  return null;
}

function jobView(job, mode, getCount = 0) {
  if (job.deletedAt !== null) {
    const done = Date.now() - job.deletedAt >= 1000;
    return { jobId: job.jobId, status: done ? 'deleted' : 'deleting', revision: done ? 5 : 4 };
  }
  if (mode === 'stale_status' && getCount > 0) {
    if (getCount === 2) return { jobId: job.jobId, status: 'processing', revision: 2 };
    return ready(job.jobId);
  }
  const elapsed = Date.now() - job.createdAt;
  if (elapsed < 250) return { jobId: job.jobId, status: 'queued', revision: 1 };
  if (elapsed < 1000) return { jobId: job.jobId, status: 'processing', revision: 2 };
  return ready(job.jobId);
}

function ready(jobId) {
  return {
    jobId, status: 'ready', revision: 3, currency: 'AUD',
    items: [
      { id: 'rec-001', merchant: 'StreamBeam', amountMinor: 1999, cadence: 'monthly', lastSeen: '2026-10-01' },
      { id: 'rec-002', merchant: 'BrightGrid', amountMinor: 13200, cadence: 'monthly', lastSeen: '2026-10-03' },
    ],
  };
}

export function createMockServer({ statePath = defaultStatePath } = {}) {
  let state = readState(statePath);
  const persist = () => saveState(statePath, state);

  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://local.test').pathname;
      if (request.method === 'GET' && path === '/health') return json(response, 200, { ok: true });
      if (request.method === 'POST' && path === '/__test/reset') {
        state = freshState(); persist(); return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && path === '/__test/scenario') {
        const payload = JSON.parse((await readBody(request, 1024)).toString('utf8'));
        if (!modes.has(payload.mode)) return json(response, 400, { error: 'unknown mode' });
        state.mode = payload.mode;
        state.getCounts = {};
        persist();
        return json(response, 200, { mode: state.mode });
      }
      if (request.method === 'GET' && path === '/__test/state') {
        return json(response, 200, {
          mode: state.mode, stats: state.stats,
          jobs: Object.values(state.jobs).map(job => ({
            ...jobView(job, 'happy'), sha256: job.sha256, bytes: job.bytes,
          })),
        });
      }
      if (request.method === 'POST' && path === '/imports') {
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
          return json(response, 400, { error: 'Idempotency-Key must be 8-128 characters' });
        }
        const fileName = request.headers['x-file-name'];
        if (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255) {
          return json(response, 400, { error: 'X-File-Name is required' });
        }
        state.stats.createRequests += 1;
        persist();
        const bytes = await readBody(request, maximumBytes);
        const type = format(bytes);
        if (!type) { persist(); return json(response, 415, { error: 'unsupported file bytes' }); }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const existingId = state.byKey[key];
        if (existingId) {
          const existing = state.jobs[existingId];
          if (existing.sha256 !== sha256) { persist(); return json(response, 409, { error: 'key reused for another file' }); }
          state.stats.duplicateHits += 1;
          persist();
          return json(response, 202, { jobId: existingId, status: 'queued', revision: 1 });
        }
        const jobId = `job-demo-${String(state.nextJobId++).padStart(3, '0')}`;
        state.jobs[jobId] = { jobId, key, sha256, bytes: bytes.length, createdAt: Date.now(), deletedAt: null };
        state.byKey[key] = jobId;
        state.stats.newJobs += 1;
        state.stats.acceptedBytes += bytes.length;
        persist();
        if (state.mode === 'lost_ack') {
          request.socket.destroy();
          return;
        }
        return json(response, 202, { jobId, status: 'queued', revision: 1 });
      }
      const byKey = path.match(/^\/imports\/by-key\/([^/]+)$/);
      if (request.method === 'GET' && byKey) {
        const key = decodeURIComponent(byKey[1]);
        const job = state.jobs[state.byKey[key]];
        return job ? json(response, 200, jobView(job, 'happy')) : json(response, 404, { error: 'job not found' });
      }
      const byId = path.match(/^\/imports\/(job-demo-\d+)$/);
      if (byId && request.method === 'GET') {
        const job = state.jobs[byId[1]];
        if (!job) return json(response, 404, { error: 'job not found' });
        const count = (state.getCounts[job.jobId] ?? 0) + 1;
        state.getCounts[job.jobId] = count;
        persist();
        return json(response, 200, jobView(job, state.mode, count));
      }
      if (byId && request.method === 'DELETE') {
        const job = state.jobs[byId[1]];
        if (!job) return json(response, 404, { error: 'job not found' });
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
          return json(response, 400, { error: 'Idempotency-Key must be 8-128 characters' });
        }
        state.stats.deleteRequests += 1;
        if (state.mode === 'delete_failure') { persist(); return json(response, 503, { error: 'temporary delete failure' }); }
        if (state.deleteKeys[key] && state.deleteKeys[key] !== job.jobId) {
          persist(); return json(response, 409, { error: 'delete key reused for another job' });
        }
        state.deleteKeys[key] = job.jobId;
        if (job.deletedAt === null) job.deletedAt = Date.now();
        persist();
        return json(response, 202, jobView(job, 'happy'));
      }
      json(response, 404, { error: 'route not found' });
    } catch (error) {
      if (response.destroyed) return;
      json(response, error.status ?? 400, { error: error.status ? error.message : 'invalid request' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createMockServer();
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => console.log(`Synthetic mock listening at http://${host}:${port}`));
}
