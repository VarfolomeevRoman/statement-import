import { Directory, File, Paths } from 'expo-file-system';

import { createImportStorageJournal } from './importStorageJournal';

const directory = new Directory(Paths.document, 'statement-import-operation');
const selections = new Directory(Paths.cache, 'statement-import-selections');

// Persistent bytes stay in the app sandbox, separate from disposable picker
// cache. Public storage and the user's original document are never modified.
export const importStorage = createImportStorageJournal({
  ensure() { directory.create({ intermediates: true, idempotent: true }); },
  list() { return directory.list().map((file) => file.name); },
  uri(name) { return new File(directory, name).uri; },
  exists(name) { return new File(directory, name).exists; },
  size(name) { return new File(directory, name).size; },
  read(name) { return new File(directory, name).text(); },
  async writeExclusive(name, content) {
    const file = new File(directory, name);
    file.create();
    await file.write(content);
  },
  async copyFrom(source, name) {
    const file = new File(source.uri);
    if (file.parentDirectory.uri !== selections.uri || !file.exists ||
      file.size !== source.size) throw new Error('Import copy unavailable');
    await file.copy(new File(directory, name));
  },
  async commit(temporary, destination) {
    await new File(directory, temporary).move(new File(directory, destination));
  },
  async remove(name) {
    const file = new File(directory, name);
    if (file.exists) file.delete();
  },
});
