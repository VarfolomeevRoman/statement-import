import type { ImportStorage, PersistedImport } from '../model/importOperation.types';
import type { SelectedStatementFile } from '../model/statementFileSelection';

// The journal never overwrites its current commit. A process interruption may
// leave a .tmp file; only a successfully renamed .json snapshot is committed.
export type ImportJournalFiles = {
  ensure(): void;
  list(): string[];
  uri(name: string): string;
  exists(name: string): boolean;
  size(name: string): number;
  read(name: string): Promise<string>;
  writeExclusive(name: string, content: string): Promise<void>;
  copyFrom(source: SelectedStatementFile, name: string): Promise<void>;
  commit(temporary: string, destination: string): Promise<void>;
  remove(name: string): Promise<void>;
};

const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const commitPattern = /^state-(\d{12})\.json$/;
const temporaryPattern = /^state-\d{12}\.tmp$/;
const payloadPattern = /^payload-[A-Za-z0-9_-]{8,128}\.bin$/;
const statuses = new Set(['queued', 'processing', 'ready', 'deleting', 'deleted']);
const submissions = new Set(['prepared', 'pending', 'rejected']);
const rejectedStatuses = new Set([413, 415]);
const maximumBytes = 10 * 1024 * 1024;
const maximumManifestBytes = 16 * 1024;

function unavailable(): never {
  // Never expose native filesystem messages containing names or document URIs.
  throw new Error('Import storage unavailable');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function payloadName(key: string) {
  if (!keyPattern.test(key)) unavailable();
  return `payload-${key}.bin`;
}

function decode(content: string, files: ImportJournalFiles): PersistedImport | null {
  const value: unknown = JSON.parse(content);
  if (object(value) && value.version === 1 && value.cleared === true) {
    if (Object.keys(value).length !== 2) unavailable();
    return null;
  }
  if (!object(value) || value.version !== 1 || typeof value.key !== 'string' ||
    !keyPattern.test(value.key)) unavailable();
  const key = value.key;
  let file: SelectedStatementFile | null = null;
  if (value.file !== null) {
    const selected = value.file;
    if (!object(selected) || selected.payload !== payloadName(key) ||
      typeof selected.name !== 'string' || !selected.name.length || selected.name.length > 4096 ||
      !Number.isSafeInteger(selected.size) || (selected.size as number) < 1 ||
      (selected.size as number) > maximumBytes ||
      (selected.format !== 'pdf' && selected.format !== 'csv')) unavailable();
    file = {
      uri: files.uri(selected.payload), name: selected.name,
      size: selected.size as number, format: selected.format,
    };
  }
  let checkpoint: PersistedImport['checkpoint'] = null;
  if (value.checkpoint !== null) {
    const saved = value.checkpoint;
    if (!object(saved) || typeof saved.jobId !== 'string' ||
      !/^job-demo-\d+$/.test(saved.jobId) || typeof saved.status !== 'string' ||
      !statuses.has(saved.status) || !Number.isSafeInteger(saved.revision) ||
      (saved.revision as number) < 1) unavailable();
    checkpoint = {
      jobId: saved.jobId, status: saved.status as NonNullable<PersistedImport['checkpoint']>['status'],
      revision: saved.revision as number,
    };
  }
  if (!file && !checkpoint) unavailable();
  if (value.deleteKey !== undefined && (typeof value.deleteKey !== 'string' ||
    !keyPattern.test(value.deleteKey) || !checkpoint)) unavailable();
  if (value.submission !== undefined && (typeof value.submission !== 'string' ||
    !submissions.has(value.submission) || checkpoint)) unavailable();
  if (value.submission === 'rejected') {
    if (typeof value.rejectedStatus !== 'number' || !rejectedStatuses.has(value.rejectedStatus)) unavailable();
  } else if (value.rejectedStatus !== undefined) unavailable();
  return {
    version: 1, key, file, checkpoint,
    ...(value.deleteKey === undefined ? {} : { deleteKey: value.deleteKey as string }),
    ...(value.submission === undefined ? {} : { submission: value.submission as PersistedImport['submission'] }),
    ...(value.rejectedStatus === undefined ? {} : { rejectedStatus: value.rejectedStatus as PersistedImport['rejectedStatus'] }),
  };
}

function encode(operation: PersistedImport, files: ImportJournalFiles) {
  const { file } = operation;
  const payload = payloadName(operation.key);
  if (file && file.uri !== files.uri(payload)) unavailable();
  const content = JSON.stringify({
    version: operation.version,
    key: operation.key,
    file: file ? { payload, name: file.name, size: file.size, format: file.format } : null,
    checkpoint: operation.checkpoint,
    ...(operation.deleteKey === undefined ? {} : { deleteKey: operation.deleteKey }),
    ...(operation.submission === undefined ? {} : { submission: operation.submission }),
    ...(operation.rejectedStatus === undefined ? {} : { rejectedStatus: operation.rejectedStatus }),
  });
  // Reuse the decoder as the exact persistent schema validator.
  decode(content, files);
  // UTF-8 uses at most four bytes per character; actual byte limit is checked
  // again by the adapter before reading persisted text.
  if (content.length * 4 > maximumManifestBytes) unavailable();
  return content;
}

export function createImportStorageJournal(files: ImportJournalFiles): ImportStorage {
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const work = queue.then(action).catch(() => unavailable());
    queue = work.catch(() => {});
    return work;
  }

  function commits() {
    return files.list().filter((name) => commitPattern.test(name)).sort();
  }

  async function latest() {
    files.ensure();
    const names = commits();
    const name = names.at(-1);
    if (!name) return { names, operation: null, cleared: false };
    if (files.size(name) > maximumManifestBytes) unavailable();
    // A corrupt committed file is not an empty store. Falling back could lose
    // a key or revision for an already accepted request and create a duplicate.
    const operation = decode(await files.read(name), files);
    return { names, operation, cleared: operation === null };
  }

  async function cleanup(operation: PersistedImport | null, names: string[], strict = false) {
    const keep = operation?.file ? payloadName(operation.key) : null;
    // Once bytes are released, retain only the latest commit without file metadata.
    // An older snapshot would otherwise keep the original filename forever
    // when the first recovered response is already ready and polling stops.
    const retainedCommits = operation?.file ? 2 : 1;
    const oldCommits = new Set(names.slice(0, -retainedCommits));
    let entries: string[];
    try { entries = files.list(); } catch { if (strict) unavailable(); return; }
    let failed = false;
    for (const name of entries) {
      if (temporaryPattern.test(name) || oldCommits.has(name) ||
        (payloadPattern.test(name) && name !== keep)) {
        // Cleanup does not invalidate a committed snapshot. Retry leftovers
        // on the next load/save instead of reporting a successful commit lost.
        try { await files.remove(name); } catch { failed = true; }
      }
    }
    if (strict && failed) unavailable();
  }

  async function commit(content: string, names: string[]) {
    const sequence = names.length ? Number(names.at(-1)!.match(commitPattern)![1]) + 1 : 1;
    if (sequence > 999999999999) unavailable();
    const stem = `state-${String(sequence).padStart(12, '0')}`;
    if (files.exists(`${stem}.tmp`)) await files.remove(`${stem}.tmp`);
    await files.writeExclusive(`${stem}.tmp`, content);
    await files.commit(`${stem}.tmp`, `${stem}.json`);
    return [...names, `${stem}.json`];
  }

  return {
    load: () => serialize(async () => {
      const { names, operation, cleared } = await latest();
      // Preserve the key even if bytes became unavailable: lookup by key can
      // still recover an accepted POST. The upload adapter validates its file
      // before any explicit retry; missing bytes never mean an empty store.
      await cleanup(operation, names, cleared);
      return operation;
    }),
    stage: (file, key) => serialize(async () => {
      const previous = await latest();
      if (previous.cleared) await cleanup(null, previous.names, true);
      const name = payloadName(key);
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximumBytes ||
        files.exists(name)) unavailable();
      try {
        await files.copyFrom(file, name);
        if (!files.exists(name) || files.size(name) !== file.size) unavailable();
        return { ...file, uri: files.uri(name) };
      } catch {
        try { await files.remove(name); } catch {}
        unavailable();
      }
    }),
    save: (operation) => serialize(async () => {
      const { names, operation: previous, cleared } = await latest();
      // A late checkpoint from an old coordinator cannot resurrect a cleared
      // operation. A new operation starts with staged bytes and no checkpoint.
      if (cleared && operation.checkpoint) unavailable();
      if (previous && (previous.key !== operation.key ||
        (previous.deleteKey !== undefined && previous.deleteKey !== operation.deleteKey) ||
        (previous.checkpoint && (!operation.checkpoint ||
          previous.checkpoint.jobId !== operation.checkpoint.jobId ||
          previous.checkpoint.revision > operation.checkpoint.revision)))) unavailable();
      if (!operation.checkpoint) {
        // Never turn an interrupted/legacy request into a never-sent one, or
        // make a terminal rejection eligible for another POST under its key.
        if (previous && operation.submission === 'prepared' && previous.submission !== 'prepared') unavailable();
        if (previous?.submission !== undefined && operation.submission === undefined) unavailable();
        if (previous?.submission === 'rejected' && (operation.submission !== 'rejected' ||
          operation.rejectedStatus !== previous.rejectedStatus)) unavailable();
        if (operation.submission === 'rejected' && previous?.submission !== 'pending' &&
          previous?.submission !== 'rejected') unavailable();
      }
      if (operation.file && !operation.checkpoint && operation.submission !== 'rejected') {
        const name = payloadName(operation.key);
        if (!files.exists(name) || files.size(name) !== operation.file.size) unavailable();
      }
      const content = encode(operation, files);
      await cleanup(operation, await commit(content, names));
    }),
    clear: (key) => serialize(async () => {
      const { names, operation, cleared } = await latest();
      if (cleared) { await cleanup(null, names, true); return; }
      const rejectedWithoutJob = operation?.submission === 'rejected' && !operation.checkpoint;
      if (!operation || operation.key !== key ||
        (operation.checkpoint?.status !== 'deleted' && !rejectedWithoutJob)) unavailable();
      // A durable, data-free tombstone precedes cleanup. Even if cleanup fails
      // or the process exits, the old import can never be read as current again.
      const committed = await commit(JSON.stringify({ version: 1, cleared: true }), names);
      await cleanup(null, committed, true);
    }),
    removePayload: (file) => serialize(async () => {
      const name = file.uri.slice(file.uri.lastIndexOf('/') + 1);
      if (!payloadPattern.test(name) || file.uri !== files.uri(name)) unavailable();
      if (files.exists(name)) await files.remove(name);
    }),
  };
}
