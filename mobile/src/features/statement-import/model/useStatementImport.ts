import { uuid } from 'expo';
import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { createImportApi } from '../api/importApi';
import { importStorage } from '../lib/importStorage';
import { clearStatementSelectionCache } from '../lib/statementFileGateway';
import { createImportOperation } from './importOperation';
import { useStatementFile } from './useStatementFile';

// One coordinator per process: remounts cannot run competing journal writers.
const operation = createImportOperation({
  api: createImportApi({
    baseUrl: process.env.EXPO_PUBLIC_IMPORT_API_URL ?? 'http://127.0.0.1:8787',
    fetch: (url, init) => expoFetch(url, { ...init, body: init.body as File | undefined }),
    bodyForFile: (file) => {
      const payload = new File(file.uri);
      if (!payload.exists || payload.size !== file.size) throw new Error('Payload unavailable');
      return payload;
    },
  }),
  storage: importStorage,
  createKey: () => uuid.v4(),
  clearSelectionCache: clearStatementSelectionCache,
});

export function useStatementImport() {
  const selection = useStatementFile();
  const state = useSyncExternalStore(operation.subscribe, operation.getSnapshot);

  useEffect(() => {
    void operation.activate();
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'active') void operation.activate();
      else operation.deactivate();
    });
    return () => { listener.remove(); operation.deactivate(); };
  }, []);

  // The operation owns a separate durable copy. Release only the picker cache.
  useEffect(() => {
    if (state.operation && selection.file && selection.status === 'idle') {
      selection.releaseFile();
    }
  }, [state.operation, selection.file, selection.status]);

  return {
    selection,
    operation: state,
    confirmUpload: () => selection.file && selection.status === 'idle'
      ? operation.confirm(selection.file) : Promise.resolve(),
    retry: operation.retry,
    refresh: operation.refresh,
    deleteImport: operation.deleteImport,
    newImport: operation.newImport,
    discardRejected: operation.discardRejected,
  };
}
