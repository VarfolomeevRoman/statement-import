import type { SelectedStatementFile } from '../model/statementFileSelection';

export type ImportItem = {
  id: string;
  merchant: string;
  amountMinor: number;
  cadence: 'monthly';
  lastSeen: string;
};

type JobIdentity = { jobId: string; revision: number };
export type ImportJob =
  | (JobIdentity & { status: 'queued' | 'processing' | 'deleting' | 'deleted' })
  | (JobIdentity & { status: 'ready'; currency: string; items: ImportItem[] });

export interface ImportApi {
  create(key: string, file: SelectedStatementFile): Promise<ImportJob>;
  findByKey(key: string): Promise<ImportJob | null>;
  get(jobId: string): Promise<ImportJob>;
  remove(jobId: string, key: string): Promise<ImportJob>;
}

/** Only fixed, safe messages cross the native/network boundary. */
export class ImportApiError extends Error {
  readonly outcome: 'rejected' | 'unknown';
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: { outcome: 'rejected' | 'unknown'; retryable: boolean; status?: number },
  ) {
    super(message);
    this.name = 'ImportApiError';
    this.outcome = options.outcome;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

type FetchOptions<TBody> = {
  method: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: TBody;
  signal: AbortSignal;
};

export type ImportFetch<TBody> = (
  url: string,
  options: FetchOptions<TBody>,
) => Promise<{ status: number; json(): Promise<unknown> }>;

const unknownError = () => new ImportApiError(
  'Не удалось получить ответ сервера. Проверьте состояние импорта перед повтором.',
  { outcome: 'unknown', retryable: true },
);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** Shared with durable storage: malformed state must never become a report. */
export function parseImportJob(value: unknown): ImportJob {
  if (!object(value) || !text(value.jobId, 128) ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw unknownError();
  }
  const identity = { jobId: value.jobId, revision: value.revision as number };
  switch (value.status) {
    case 'queued':
    case 'processing':
    case 'deleting':
    case 'deleted':
      return { ...identity, status: value.status };
    case 'ready': {
      if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) ||
          !Array.isArray(value.items) || value.items.length > 1000) throw unknownError();
      const ids = new Set<string>();
      let total = 0;
      const items: ImportItem[] = value.items.map((item: unknown) => {
        if (!object(item) || !text(item.id, 128) || ids.has(item.id) ||
            !text(item.merchant, 500) || !Number.isSafeInteger(item.amountMinor) ||
            (item.amountMinor as number) < 0 || item.cadence !== 'monthly' ||
            !validDate(item.lastSeen)) throw unknownError();
        ids.add(item.id);
        total += item.amountMinor as number;
        if (!Number.isSafeInteger(total)) throw unknownError();
        return {
          id: item.id,
          merchant: item.merchant,
          amountMinor: item.amountMinor as number,
          cadence: 'monthly',
          lastSeen: item.lastSeen,
        };
      });
      return { ...identity, status: 'ready', currency: value.currency, items };
    }
    default:
      throw unknownError();
  }
}

function requestError(status: number): ImportApiError {
  const messages: Record<number, string> = {
    400: 'Сервер отклонил параметры импорта.',
    404: 'Импорт пока не найден на сервере.',
    409: 'Ключ импорта уже связан с другим содержимым. Повторная отправка остановлена.',
    413: 'Сервер отклонил файл: превышен допустимый размер.',
    415: 'Сервер не поддерживает содержимое выбранного файла.',
  };
  // A proxy's request timeout does not prove that the origin rejected the POST.
  const rejected = status >= 400 && status < 500 && status !== 408;
  return new ImportApiError(messages[status] ?? 'Сервер временно недоступен. Попробуйте проверить состояние позже.', {
    outcome: rejected ? 'rejected' : 'unknown',
    retryable: !rejected || status === 429 || status === 404,
    status,
  });
}

// Fetch headers are byte strings. Keep normal names intact; encode Unicode and
// controls, and bound metadata to the mock contract. The payload is never encoded.
function fileNameHeader(name: string): string {
  let result = '';
  for (const character of name) {
    let part: string;
    if (/^[\x20-\x7E]$/.test(character)) part = character;
    else {
      try { part = encodeURIComponent(character); }
      catch { part = '_'; }
    }
    if (result.length + part.length > 255) break;
    result += part;
  }
  return result.trim() || 'statement';
}

export function createImportApi<TBody>(options: {
  baseUrl: string;
  fetch: ImportFetch<TBody>;
  bodyForFile(file: SelectedStatementFile): TBody | Promise<TBody>;
  timeoutMs?: number;
}): ImportApi {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15000;

  async function request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    headers: Record<string, string> = {},
    body?: TBody,
    allowNotFound = false,
  ): Promise<ImportJob | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await options.fetch(`${baseUrl}${path}`, {
            method, headers: { Accept: 'application/json', ...headers }, body,
            signal: controller.signal,
          });
          if (allowNotFound && response.status === 404) return null;
          if (response.status !== (method === 'GET' ? 200 : 202)) throw requestError(response.status);
          const job = parseImportJob(await response.json());
          if (method === 'POST' && job.status !== 'queued') throw unknownError();
          if (method === 'DELETE' && job.status !== 'deleting' && job.status !== 'deleted') throw unknownError();
          return job;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(unknownError());
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof ImportApiError) throw error;
      throw unknownError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async create(key, file) {
      let body: TBody;
      try { body = await options.bodyForFile(file); }
      catch {
        throw new ImportApiError('Не удалось прочитать сохранённую копию файла. Файл не отправлен.', {
          outcome: 'rejected', retryable: true,
        });
      }
      return (await request('/imports', 'POST', {
        'Content-Type': 'application/octet-stream',
        'Idempotency-Key': key,
        'X-File-Name': fileNameHeader(file.name),
      }, body))!;
    },
    findByKey(key) {
      return request(`/imports/by-key/${encodeURIComponent(key)}`, 'GET', {}, undefined, true);
    },
    async get(jobId) {
      const job = (await request(`/imports/${encodeURIComponent(jobId)}`, 'GET'))!;
      if (job.jobId !== jobId) throw unknownError();
      return job;
    },
    async remove(jobId, key) {
      // This is an acknowledgement, including an idempotent repeat that already
      // says deleted. Only a subsequent GET confirms completion to the model.
      const job = (await request(`/imports/${encodeURIComponent(jobId)}`, 'DELETE', {
        'Idempotency-Key': key,
      }))!;
      if (job.jobId !== jobId) throw unknownError();
      return job;
    },
  };
}
