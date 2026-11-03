import { ImportApiError } from '../api/importApi.ts';
import type { ImportApi, ImportJob } from '../api/importApi';
import type { ImportOperationState, ImportStorage, PersistedImport } from './importOperation.types';
import type { SelectedStatementFile } from './statementFileSelection';

const rank = { queued: 0, processing: 1, ready: 2, deleting: 3, deleted: 4 };
const unknownOutcome = 'Ответ об отправке не получен. Импорт мог быть создан. Повтор сначала проверит его состояние и при необходимости отправит тот же файл.';
const storageError = 'Не удалось сохранить или восстановить операцию. Запрос остановлен. Повторите проверку.';
const deleteUnconfirmed = 'Удаление ещё не подтверждено. Нажмите «Повторить удаление», чтобы проверить состояние и при необходимости повторить запрос.';
const deleteFailed = 'Не удалось подтвердить удаление. Импорт мог остаться на сервере. Повторите удаление после восстановления связи.';

function rejectionMessage(status: PersistedImport['rejectedStatus']) {
  return status === 413
    ? 'Сервер отклонил файл: превышен допустимый размер. Выберите другую выписку.'
    : 'Сервер не поддерживает содержимое файла. Выберите другую выписку.';
}

export function createImportOperation(dependencies: {
  api: ImportApi;
  storage: ImportStorage;
  createKey: () => string;
  clearSelectionCache?: () => Promise<void>;
  schedule?: (callback: () => void, delay: number) => () => void;
}) {
  const { api, storage, createKey } = dependencies;
  const schedule = dependencies.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  });
  let state: ImportOperationState = {
    operation: null, job: null, phase: 'restoring', error: null, storageBlocked: false,
  };
  const listeners = new Set<() => void>();
  let active = false;
  let generation = 0;
  let busy = false;
  let currentTask: Promise<void> = Promise.resolve();
  let cancelPoll: (() => void) | undefined;

  function update(next: Partial<ImportOperationState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }
  function stopPoll() { cancelPoll?.(); cancelPoll = undefined; }
  function current(token: number) { return active && generation === token; }
  function failStorage(token: number) {
    if (current(token)) update({ phase: 'error', error: storageError, storageBlocked: true });
  }
  function settle(token: number) {
    if (!current(token)) return;
    const status = state.operation?.checkpoint?.status;
    if (state.operation?.deleteKey && status !== 'deleting' && status !== 'deleted') {
      update({ phase: 'error', error: deleteUnconfirmed });
      return;
    }
    if (status === 'ready' && state.job?.status !== 'ready') {
      update({ phase: 'error', error: 'Результат ещё не удалось получить. Повторите проверку.' });
      return;
    }
    update({ phase: status === 'ready' ? 'ready' : status === 'deleting' ? 'deleting' : 'waiting', error: null });
    if (status === 'queued' || status === 'processing' || status === 'deleting') {
      stopPoll();
      cancelPoll = schedule(() => { void controller.refresh(); }, 1000);
    }
  }
  async function finishDeleted(token: number) {
    const operation = state.operation;
    if (!current(token) || operation?.checkpoint?.status !== 'deleted') return;
    stopPoll();
    const deleted: ImportJob = { ...operation.checkpoint, status: 'deleted' };
    // Keep the terminal checkpoint until a durable tombstone replaces it.
    // Clear failures must not re-enable upload or discard the recovery record.
    update({ job: deleted, phase: 'deleting', error: null });
    try {
      await dependencies.clearSelectionCache?.();
      if (!current(token)) return;
      await storage.clear(operation.key);
      if (!current(token)) return;
      update({ operation: null, job: deleted, phase: 'deleted', error: null, storageBlocked: false });
    } catch {
      if (current(token)) update({ phase: 'error', error: 'Сервер подтвердил удаление, но локальные данные ещё не очищены. Повторите очистку.' });
    }
  }
  // Only remove payload after the job checkpoint is durably saved. A crash
  // between deletion and the next save is safe: a known job needs only GET.
  async function releasePayload(token: number) {
    const operation = state.operation;
    if (!operation?.checkpoint || !operation.file) return true;
    try {
      await storage.removePayload(operation.file);
      if (!current(token)) return false;
      const next = { ...operation, file: null };
      await storage.save(next);
      if (!current(token)) return false;
      update({ operation: next });
      return true;
    } catch {
      if (current(token)) update({ phase: 'error', error: 'Импорт найден, но не удалось убрать локальную копию. Повторите проверку.' });
      return false;
    }
  }
  async function accept(job: ImportJob, token: number) {
    if (!current(token) || !state.operation) return;
    const previous = state.operation.checkpoint;
    if (previous && job.jobId !== previous.jobId) {
      update({ phase: 'error', error: 'Сервер вернул другую операцию. Повторите проверку.' });
      return;
    }
    if (previous && (job.revision < previous.revision || rank[job.status] < rank[previous.status] ||
      (job.revision === previous.revision && job.status !== previous.status))) {
      settle(token);
      return;
    }
    const { submission: _submission, rejectedStatus: _rejectedStatus, ...acceptedOperation } = state.operation;
    const next: PersistedImport = {
      ...acceptedOperation,
      checkpoint: { jobId: job.jobId, status: job.status, revision: job.revision },
    };
    try { await storage.save(next); } catch { failStorage(token); return; }
    if (!current(token)) return;
    update({ operation: next, job, storageBlocked: false });
    if (job.status === 'deleted') { await finishDeleted(token); return; }
    if (await releasePayload(token)) settle(token);
  }
  async function check(token: number, mayUpload: boolean) {
    const operation = state.operation;
    if (!operation || !current(token)) return;
    if (operation.checkpoint?.status === 'deleted') { await finishDeleted(token); return; }
    if (operation.submission === 'rejected' && !operation.checkpoint) {
      update({ phase: 'error', error: rejectionMessage(operation.rejectedStatus) });
      return;
    }
    update({ phase: 'checking', error: null });
    let job: ImportJob | null;
    try {
      job = operation.checkpoint
        ? await api.get(operation.checkpoint.jobId)
        : await api.findByKey(operation.key);
    } catch {
      if (current(token)) update({ phase: 'error', error: operation.deleteKey ? deleteFailed : operation.checkpoint
        ? 'Не удалось проверить импорт. Проверьте подключение и повторите.'
        : unknownOutcome });
      return;
    }
    if (!current(token)) return;
    if (job) {
      await accept(job, token);
      // A retry reconciles the server first. Never issue another DELETE while
      // it is already deleting, or silently upload an operation being removed.
      if (mayUpload && current(token) && state.operation?.deleteKey &&
        !state.storageBlocked && state.error === deleteUnconfirmed) {
        await sendDelete(token);
      }
      return;
    }
    if (mayUpload && operation.file && !operation.checkpoint) {
      await upload(token);
    } else {
      update({ phase: 'error', error: unknownOutcome });
    }
  }
  async function sendDelete(token: number) {
    const operation = state.operation;
    if (!current(token) || !operation?.deleteKey || !operation.checkpoint) return;
    update({ phase: 'deleting', error: null });
    try {
      const receipt = await api.remove(operation.checkpoint.jobId, operation.deleteKey);
      if (!current(token)) return;
      // Even a repeated DELETE returning 202/deleted is only an ACK.
      // Persist terminal deletion exclusively from authoritative GET.
      if (receipt.status === 'deleting') await accept(receipt, token);
      if (current(token) && !state.storageBlocked && state.phase !== 'error') {
        stopPoll();
        await check(token, false);
      }
    } catch {
      if (current(token)) {
        stopPoll();
        update({ phase: 'error', error: deleteFailed });
      }
    }
  }
  async function upload(token: number) {
    const operation = state.operation;
    if (!operation?.file || !current(token) || operation.submission === 'rejected') return;
    // Missing legacy markers and interrupted pending requests remain ambiguous.
    // A later rejected retry must never erase that earlier request's key.
    const firstAttempt = operation.submission === 'prepared';
    update({ phase: 'uploading', error: null });
    try {
      const pending: PersistedImport = { ...operation, submission: 'pending' };
      await storage.save(pending);
      if (!current(token)) return;
      update({ operation: pending });
    } catch { failStorage(token); return; }
    try {
      const receipt = await api.create(operation.key, operation.file);
      if (!current(token)) return;
      // 202 is only an acknowledgement. Render a report only from a GET.
      await accept(receipt, token);
      if (current(token) && !state.storageBlocked && state.phase !== 'error') {
        stopPoll();
        await check(token, false);
      }
    } catch (error) {
      if (!current(token)) return;
      if (error instanceof ImportApiError && error.outcome === 'rejected') {
        // These two mock responses occur before creating any job. Generic 400,
        // 409 conflicts, timeouts, and rejections after an unknown attempt do not
        // establish that no server operation exists.
        if (firstAttempt && (error.status === 413 || error.status === 415)) {
          const rejected: PersistedImport = {
            ...operation, submission: 'rejected', rejectedStatus: error.status,
          };
          try { await storage.save(rejected); } catch { failStorage(token); return; }
          if (!current(token)) return;
          update({ operation: rejected, phase: 'error', error: rejectionMessage(error.status) });
          return;
        }
        update({ phase: 'error', error: error.message });
      } else {
        // The connection may have failed after the server committed the job.
        await check(token, false);
      }
    }
  }
  async function restore(token: number) {
    if (!current(token)) return;
    update({ phase: 'restoring', error: null });
    try {
      const operation = await storage.load();
      if (!current(token)) return;
      const sameOperation = operation?.key === state.operation?.key;
      update({ operation, job: sameOperation ? state.job : null, storageBlocked: false });
      if (operation) await check(token, false); // Relaunch never initiates POST/DELETE.
      else update({ phase: 'idle' });
    } catch { failStorage(token); }
  }
  function run(action: (token: number) => Promise<void>) {
    if (!active || busy) return Promise.resolve();
    stopPoll();
    busy = true;
    const token = generation;
    currentTask = action(token).catch(() => { failStorage(token); }).finally(() => { busy = false; });
    return currentTask;
  }
  const controller = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() {
      active = true;
      const token = ++generation;
      stopPoll();
      update({ phase: 'restoring' });
      // Finish any earlier filesystem commit before reading the journal again.
      const earlier = currentTask;
      currentTask = earlier.then(async () => {
        if (!current(token)) return;
        busy = true;
        try { await restore(token); } finally { busy = false; }
      });
      return currentTask;
    },
    deactivate() { active = false; generation += 1; stopPoll(); },
    confirm(file: SelectedStatementFile) {
      if (state.operation || state.phase !== 'idle' || state.storageBlocked) return Promise.resolve();
      return run(async (token) => {
        update({ phase: 'saving', error: null });
        try {
          const key = createKey();
          const staged = await storage.stage(file, key);
          if (!current(token)) return;
          const operation: PersistedImport = { version: 1, key, file: staged, checkpoint: null, submission: 'prepared' };
          await storage.save(operation);
          if (!current(token)) return;
          update({ operation });
        } catch { failStorage(token); return; }
        await upload(token);
      });
    },
    discardRejected() {
      const operation = state.operation;
      if (state.storageBlocked || operation?.submission !== 'rejected' ||
        operation.checkpoint || operation.deleteKey) return Promise.resolve();
      return run(async (token) => {
        update({ phase: 'clearing', error: null });
        try {
          await dependencies.clearSelectionCache?.();
          if (!current(token)) return;
          await storage.clear(operation.key);
          if (!current(token)) return;
          generation += 1;
          update({ operation: null, job: null, phase: 'idle', error: null });
        } catch {
          if (current(token)) update({ phase: 'error', error: 'Не удалось убрать локальную копию отклонённого файла. Повторите выбор другого файла.' });
        }
      });
    },
    deleteImport() {
      const operation = state.operation;
      const status = operation?.checkpoint?.status;
      if (!operation || !status || operation.deleteKey || state.storageBlocked ||
        status === 'deleting' || status === 'deleted') return Promise.resolve();
      return run(async (token) => {
        update({ phase: 'deleting', error: null });
        try {
          const deleteKey = createKey();
          if (deleteKey === operation.key) throw new Error('Deletion requires a separate key');
          const next = { ...operation, deleteKey };
          await storage.save(next);
          if (!current(token)) return;
          update({ operation: next });
        } catch { failStorage(token); return; }
        await sendDelete(token);
      });
    },
    newImport() {
      if (state.phase !== 'deleted' || state.operation || state.storageBlocked) return Promise.resolve();
      return run(async () => {
        generation += 1;
        update({ job: null, phase: 'idle', error: null });
      });
    },
    retry() {
      if (state.phase === 'deleted') return Promise.resolve();
      return run((token) => state.storageBlocked || !state.operation
        ? restore(token) : check(token, true));
    },
    refresh() {
      if (state.phase === 'deleted') return Promise.resolve();
      return run((token) => state.storageBlocked || !state.operation
        ? restore(token) : check(token, false));
    },
  };
  return controller;
}
