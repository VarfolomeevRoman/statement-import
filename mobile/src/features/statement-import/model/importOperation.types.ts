import type { ImportJob } from '../api/importApi';
import type { SelectedStatementFile } from './statementFileSelection';

export type ImportCheckpoint = Pick<ImportJob, 'jobId' | 'status' | 'revision'>;

// No transaction details are persisted. GET retrieves the report after relaunch.
export type PersistedImport = {
  version: 1;
  key: string;
  file: SelectedStatementFile | null;
  checkpoint: ImportCheckpoint | null;
  // Persisted before the first DELETE and reused on every explicit retry.
  deleteKey?: string;
  // Legacy records without this field have an unknown upload outcome.
  // Persist pending before POST; only an unambiguous first-attempt rejection
  // permits discarding an operation without a server job.
  submission?: 'prepared' | 'pending' | 'rejected';
  rejectedStatus?: 413 | 415;
};

export type ImportStorage = {
  load(): Promise<PersistedImport | null>;
  stage(file: SelectedStatementFile, key: string): Promise<SelectedStatementFile>;
  save(operation: PersistedImport): Promise<void>;
  removePayload(file: SelectedStatementFile): Promise<void>;
  clear(key: string): Promise<void>;
};

export type ImportOperationState = {
  operation: PersistedImport | null;
  job: ImportJob | null;
  phase: 'restoring' | 'idle' | 'saving' | 'uploading' | 'checking' | 'waiting' | 'ready' | 'deleting' | 'deleted' | 'clearing' | 'error';
  error: string | null;
  // A failed local commit must be reloaded before a new operation can start.
  storageBlocked: boolean;
};
