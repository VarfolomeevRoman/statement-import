export type SelectedStatementFile = {
  uri: string;
  name: string;
  size: number;
  format: 'pdf' | 'csv';
};

export type FileSelectionState = {
  file: SelectedStatementFile | null;
  status: 'idle' | 'picking' | 'validating' | 'clearing';
  error: string | null;
};

// Only messages explicitly created by the file adapter may reach the UI.
// Native errors can contain document names/URIs and must not be logged or shown.
export class StatementFileSelectionError extends Error {}

export type StatementFileGateway = {
  initialize?: () => void;
  pick: (onPicked: () => void) => Promise<SelectedStatementFile | null>;
  remove: (file: SelectedStatementFile, options?: { retryOnNextAction: boolean }) => Promise<void>;
};

export function createStatementFileSelection(gateway: StatementFileGateway) {
  let state: FileSelectionState = { file: null, status: 'idle', error: null };
  const listeners = new Set<() => void>();
  let active = true;
  let generation = 0;
  let busy = false;

  function update(next: Partial<FileSelectionState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }

  // A failed best-effort cleanup is retried by the adapter on its next action
  // and by startup cleanup after a process restart. Never log native errors.
  async function discard(file: SelectedStatementFile) {
    try {
      await gateway.remove(file, { retryOnNextAction: true });
    } catch {}
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() {
      active = true;
      try {
        gateway.initialize?.();
      } catch {
        update({ error: 'Не удалось очистить временные файлы. Повторите выбор файла.' });
      }
    },
    deactivate() {
      active = false;
      generation += 1;
      const previous = state.file;
      state = { file: null, status: 'idle', error: null };
      if (previous) void discard(previous);
    },
    releaseFile() {
      // A confirmed operation owns a different durable copy. The picker copy
      // is now abandoned; failed deletion may be retried without harming it.
      if (busy || !state.file) return;
      const previous = state.file;
      update({ file: null, error: null });
      void discard(previous);
    },
    async pickFile() {
      if (!active || busy) return;
      busy = true;
      const request = ++generation;
      const isCurrent = () => active && request === generation;
      let candidate: SelectedStatementFile | null = null;
      update({ status: 'picking', error: null });
      try {
        candidate = await gateway.pick(() => {
          if (isCurrent()) update({ status: 'validating' });
        });
        if (!isCurrent()) {
          if (candidate) await discard(candidate);
          return;
        }
        // Canceling the system dialog preserves an existing selection.
        if (!candidate) return;
        if (state.file) await gateway.remove(state.file);
        if (!isCurrent()) {
          await discard(candidate);
          return;
        }
        update({ file: candidate });
        candidate = null; // Ownership has moved to the current selection.
      } catch (error) {
        if (candidate) await discard(candidate);
        if (isCurrent()) {
          update({ error: error instanceof StatementFileSelectionError
            ? error.message
            : 'Не удалось выбрать файл. Попробуйте ещё раз.' });
        }
      } finally {
        busy = false;
        if (isCurrent()) update({ status: 'idle' });
      }
    },
    async clearFile() {
      if (!active || busy || !state.file) return;
      busy = true;
      const request = ++generation;
      update({ status: 'clearing', error: null });
      try {
        await gateway.remove(state.file);
        if (active && request === generation) update({ file: null });
      } catch {
        if (active && request === generation) {
          update({ error: 'Не удалось убрать временную копию. Попробуйте ещё раз.' });
        }
      } finally {
        busy = false;
        if (active && request === generation) update({ status: 'idle' });
      }
    },
  };
}
