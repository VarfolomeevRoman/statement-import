import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStatementFileSelection,
  StatementFileSelectionError,
} from './statementFileSelection.ts';

const pdf = {
  uri: 'file:///test-cache/first.pdf',
  name: 'statement.pdf',
  size: 128,
  format: 'pdf',
};
const csv = {
  uri: 'file:///test-cache/second.csv',
  name: 'statement.csv',
  size: 64,
  format: 'csv',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup(...outcomes) {
  const removed = [];
  const gateway = {
    async pick(onPicked) {
      const outcome = outcomes.shift();
      if (outcome !== null) onPicked();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async remove(file) {
      removed.push(file);
    },
  };
  return { gateway, removed, model: createStatementFileSelection(gateway) };
}

test('canceling the system picker keeps the previous selection and its copy', async () => {
  const { model, removed } = setup(pdf, null);
  await model.pickFile();
  await model.pickFile();

  assert.equal(model.getSnapshot().file, pdf);
  assert.equal(model.getSnapshot().status, 'idle');
  assert.equal(model.getSnapshot().error, null);
  assert.deepEqual(removed, []);
});

test('replacing the file removes the previous private copy and retains the new one', async () => {
  const { model, removed } = setup(pdf, csv);
  await model.pickFile();
  await model.pickFile();

  assert.equal(model.getSnapshot().file, csv);
  assert.equal(model.getSnapshot().status, 'idle');
  assert.equal(model.getSnapshot().error, null);
  assert.deepEqual(removed, [pdf]);
});

test('a rejected replacement keeps the previous file and presents the safe validation message', async () => {
  const message = 'Содержимое файла не похоже на PDF.';
  const { model, removed } = setup(pdf, new StatementFileSelectionError(message));
  await model.pickFile();
  await model.pickFile();

  assert.equal(model.getSnapshot().file, pdf);
  assert.equal(model.getSnapshot().status, 'idle');
  assert.equal(model.getSnapshot().error, message);
  assert.deepEqual(removed, []);
});

test('repeated taps cannot open a second picker while the first selection is pending', async () => {
  const selection = deferred();
  let calls = 0;
  let picked;
  const model = createStatementFileSelection({
    pick(onPicked) {
      calls += 1;
      picked = onPicked;
      return selection.promise;
    },
    async remove() {},
  });

  const first = model.pickFile();
  await model.pickFile();
  assert.equal(calls, 1);
  assert.equal(model.getSnapshot().status, 'picking');

  picked();
  assert.equal(model.getSnapshot().status, 'validating');
  await model.pickFile();
  assert.equal(calls, 1);

  selection.resolve(pdf);
  await first;
  assert.equal(model.getSnapshot().file, pdf);
  assert.equal(model.getSnapshot().status, 'idle');
});

test('a file returned after leaving the screen is discarded and cannot reappear', async () => {
  const selection = deferred();
  const removed = [];
  const model = createStatementFileSelection({
    pick: () => selection.promise,
    async remove(file) { removed.push(file); },
  });

  const pending = model.pickFile();
  model.deactivate();
  selection.resolve(pdf);
  await pending;

  assert.deepEqual(removed, [pdf]);
  assert.deepEqual(model.getSnapshot(), { file: null, status: 'idle', error: null });
});

test('a previous picker result stays obsolete even when the screen is reactivated', async () => {
  const selection = deferred();
  const removed = [];
  const model = createStatementFileSelection({
    pick: () => selection.promise,
    async remove(file) { removed.push(file); },
  });

  const pending = model.pickFile();
  model.deactivate();
  model.activate();
  selection.resolve(pdf);
  await pending;

  assert.deepEqual(removed, [pdf]);
  assert.equal(model.getSnapshot().file, null);
  assert.equal(model.getSnapshot().status, 'idle');
});

test('failed cleanup does not claim the file was cleared, and retry can finish cleanup', async () => {
  const { model, gateway } = setup(pdf);
  await model.pickFile();
  let attempts = 0;
  gateway.remove = async (file) => {
    assert.equal(file, pdf);
    attempts += 1;
    if (attempts === 1) throw new Error('Permission denied: file:///private/statement.pdf');
  };

  await model.clearFile();
  assert.equal(model.getSnapshot().file, pdf);
  assert.equal(model.getSnapshot().status, 'idle');
  assert.equal(model.getSnapshot().error, 'Не удалось убрать временную копию. Попробуйте ещё раз.');

  await model.clearFile();
  assert.equal(attempts, 2);
  assert.deepEqual(model.getSnapshot(), { file: null, status: 'idle', error: null });
});

test('canceling a picker after failed clear preserves both the selected file and its bytes', async () => {
  const disk = new Set([pdf.uri]);
  const cleanupQueue = new Set();
  let picks = 0;
  let failRemoval = true;
  const model = createStatementFileSelection({
    async pick() {
      // The next gateway action retries deletion of abandoned copies.
      for (const uri of cleanupQueue) disk.delete(uri);
      cleanupQueue.clear();
      return picks++ === 0 ? pdf : null;
    },
    async remove(file, { retryOnNextAction = false } = {}) {
      if (failRemoval) {
        failRemoval = false;
        if (retryOnNextAction) cleanupQueue.add(file.uri);
        throw new Error('Temporary filesystem failure');
      }
      disk.delete(file.uri);
    },
  });

  await model.pickFile();
  await model.clearFile();
  assert.equal(model.getSnapshot().file, pdf);
  assert.ok(model.getSnapshot().error);

  await model.pickFile(); // The user cancels choosing a replacement.
  assert.equal(model.getSnapshot().file, pdf);
  assert.equal(disk.has(pdf.uri), true, 'a still-selected copy must remain readable');
  assert.equal(model.getSnapshot().status, 'idle');
});

test('failed cleanup of an abandoned late picker result is retried by the next action', async () => {
  const selection = deferred();
  const disk = new Set([pdf.uri]);
  const cleanupQueue = new Set();
  let picks = 0;
  let failRemoval = true;
  const model = createStatementFileSelection({
    async pick() {
      for (const uri of cleanupQueue) disk.delete(uri);
      cleanupQueue.clear();
      return picks++ === 0 ? selection.promise : null;
    },
    async remove(file, { retryOnNextAction = false } = {}) {
      if (failRemoval) {
        failRemoval = false;
        if (retryOnNextAction) cleanupQueue.add(file.uri);
        throw new Error('Temporary filesystem failure');
      }
      disk.delete(file.uri);
    },
  });

  const pending = model.pickFile();
  model.deactivate();
  selection.resolve(pdf);
  await pending;
  assert.equal(model.getSnapshot().file, null);
  assert.equal(disk.has(pdf.uri), true, 'failed deletion leaves a copy to retry');

  model.activate();
  await model.pickFile();
  assert.equal(disk.has(pdf.uri), false, 'an abandoned copy must be cleaned on the next action');
  assert.deepEqual(model.getSnapshot(), { file: null, status: 'idle', error: null });
});

test('failed cleanup during replacement preserves the old selection and discards the new copy', async () => {
  const { model, gateway } = setup(pdf, csv);
  await model.pickFile();
  const removed = [];
  gateway.remove = async (file) => {
    if (file === pdf) throw new Error('Native cleanup failed');
    removed.push(file);
  };

  await model.pickFile();
  assert.equal(model.getSnapshot().file, pdf);
  assert.equal(model.getSnapshot().status, 'idle');
  assert.equal(model.getSnapshot().error, 'Не удалось выбрать файл. Попробуйте ещё раз.');
  assert.deepEqual(removed, [csv]);
});

test('native picker errors never expose the document name or URI in the UI state', async () => {
  const secretName = 'private-account-statement.pdf';
  const secretUri = `content://documents/accounts/${secretName}`;
  const { model } = setup(new Error(`Failed to open ${secretName} at ${secretUri}`));
  await model.pickFile();

  const state = model.getSnapshot();
  assert.equal(state.file, null);
  assert.equal(state.status, 'idle');
  assert.equal(state.error, 'Не удалось выбрать файл. Попробуйте ещё раз.');
  assert.equal(JSON.stringify(state).includes(secretName), false);
  assert.equal(JSON.stringify(state).includes(secretUri), false);
});

test('handoff releases only the abandoned picker copy and queues failed cleanup once', async () => {
  const { model, gateway } = setup(pdf);
  await model.pickFile();
  const attempts = [];
  gateway.remove = async (selected, options) => {
    attempts.push({ selected, options });
    throw new Error('temporary failure');
  };
  model.releaseFile();
  model.releaseFile();
  assert.equal(model.getSnapshot().file, null);
  assert.equal(model.getSnapshot().error, null);
  assert.deepEqual(attempts, [{ selected: pdf, options: { retryOnNextAction: true } }]);
});
