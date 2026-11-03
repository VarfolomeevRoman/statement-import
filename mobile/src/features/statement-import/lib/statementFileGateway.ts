import { getDocumentAsync } from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import { StatementFileSelectionError } from '../model/statementFileSelection';
import type { StatementFileGateway } from '../model/statementFileSelection';
import {
  STATEMENT_SNIFF_BYTES,
  validateStatementContent,
  validateStatementSize,
} from './validateStatementFile';

const selections = new Directory(Paths.cache, 'statement-import-selections');
// DocumentPicker is used only by this feature. Both directories contain app
// copies, never the user's source document or its content:// provider URI.
const pickerCopies = new Directory(Paths.cache, 'DocumentPicker');
const pendingCleanup = new Set<string>();
let initialized = false;

function isOwned(file: File) {
  return file.parentDirectory.uri === selections.uri ||
    file.parentDirectory.uri === pickerCopies.uri;
}

function removeCopy(uri: string, retryOnNextAction = false) {
  const file = new File(uri);
  if (!isOwned(file)) throw new Error('Unexpected file location');
  if (retryOnNextAction) pendingCleanup.add(uri);
  if (file.exists) file.delete();
  pendingCleanup.delete(uri);
}

function prepareCache() {
  if (!initialized) {
    // Selection has no persisted operation yet. An interrupted previous session
    // leaves only disposable copies; remove those before opening another picker.
    for (const directory of [selections, pickerCopies]) {
      if (directory.exists) directory.delete();
    }
    initialized = true;
  }
  // The OS may evict cache directories while the application is suspended.
  selections.create({ intermediates: true, idempotent: true });
  for (const uri of pendingCleanup) removeCopy(uri);
}

// Called only after GET confirmed deletion, while a persisted operation still
// prevents opening the picker. Retry failures before clearing that operation.
export async function clearStatementSelectionCache() {
  for (const directory of [selections, pickerCopies]) {
    if (directory.exists) directory.delete();
  }
  pendingCleanup.clear();
}

export const statementFileGateway: StatementFileGateway = {
  initialize: prepareCache,
  async pick(onPicked) {
    const ownedUris = new Set<string>();
    try {
      prepareCache();
      const result = await getDocumentAsync({
        multiple: false,
        copyToCacheDirectory: true,
        type: [
          'application/pdf', 'text/csv', 'text/comma-separated-values',
          'application/csv', 'text/plain', 'application/vnd.ms-excel',
        ],
      });
      if (result.canceled) return null;
      const asset = result.assets[0];
      if (!asset) throw new Error('No document returned');
      const copy = new File(asset.uri);
      if (!isOwned(copy)) throw new Error('Expected a private picker copy');
      ownedUris.add(copy.uri);
      onPicked();

      // Native picker streams a disk copy. Only stat + a bounded prefix are
      // read here; bytes()/text()/base64() must not load a large file into JS.
      const size = copy.size;
      if (!copy.exists || size == null || !Number.isSafeInteger(size) || size < 0) {
        throw new StatementFileSelectionError('Не удалось определить размер файла. Выберите другой файл.');
      }
      const sizeError = validateStatementSize(size);
      if (sizeError) throw new StatementFileSelectionError(sizeError.message);

      const handle = copy.open(FileMode.ReadOnly);
      let prefix: Uint8Array;
      try {
        prefix = await handle.readBytes(Math.min(size, STATEMENT_SNIFF_BYTES));
      } finally {
        handle.close();
      }
      const validation = validateStatementContent({ ...asset, size }, prefix);
      if (!validation.ok) throw new StatementFileSelectionError(validation.error.message);

      // The picker's random basename contains no original document name.
      const destination = new File(selections, copy.name);
      if (destination.exists) throw new Error('Selection copy already exists');
      ownedUris.add(destination.uri);
      await copy.move(destination);
      const selected = {
        uri: destination.uri, name: asset.name, size, format: validation.format,
      };
      ownedUris.clear();
      return selected;
    } catch (error) {
      let cleanupFailed = false;
      for (const uri of ownedUris) {
        try { removeCopy(uri, true); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new StatementFileSelectionError('Не удалось убрать временную копию. Повторите выбор файла.');
      if (error instanceof StatementFileSelectionError) throw error;
      throw new StatementFileSelectionError('Не удалось прочитать файл. Попробуйте скачать его на устройство и выбрать снова.');
    }
  },
  async remove(file, options) {
    try {
      removeCopy(file.uri, options?.retryOnNextAction);
    } catch {
      throw new StatementFileSelectionError('Не удалось убрать временную копию. Попробуйте ещё раз.');
    }
  },
};
