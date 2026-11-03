export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
export const STATEMENT_SNIFF_BYTES = 8192;

export type StatementFormat = 'pdf' | 'csv';

export type StatementFileMetadata = {
  name: string;
  size?: number | null;
  mimeType?: string | null;
};

export type StatementValidationError = {
  code: 'too-large' | 'empty' | 'invalid-size' | 'unsupported-format' | 'invalid-pdf' | 'invalid-csv';
  message: string;
};

export type StatementValidationResult =
  | { ok: true; format: StatementFormat }
  | { ok: false; error: StatementValidationError };

/** Unknown picker metadata is allowed here; the file adapter must obtain the real size. */
export function validateStatementSize(size: number | null | undefined): StatementValidationError | null {
  if (size == null) return null;
  if (!Number.isSafeInteger(size) || size < 0) {
    return { code: 'invalid-size', message: 'Не удалось определить размер файла. Выберите другой файл.' };
  }
  if (size > MAX_STATEMENT_BYTES) {
    return { code: 'too-large', message: 'Файл больше 10 МиБ. Выберите выписку меньшего размера.' };
  }
  if (size === 0) {
    return { code: 'empty', message: 'Файл пуст. Выберите другую выписку.' };
  }
  return null;
}

export function validateStatementContent(
  metadata: StatementFileMetadata,
  prefix: Uint8Array,
): StatementValidationResult {
  const sizeError = validateStatementSize(metadata.size);
  if (sizeError) return { ok: false, error: sizeError };
  if (prefix.length === 0) {
    return { ok: false, error: { code: 'empty', message: 'Файл пуст. Выберите другую выписку.' } };
  }

  const sample = prefix.subarray(0, STATEMENT_SNIFF_BYTES);
  // This bounded signature check identifies a likely PDF, not a fully parsed or safe document.
  if ([0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => sample[index] === byte)) {
    return { ok: true, format: 'pdf' };
  }

  const mime = metadata.mimeType?.split(';')[0].trim().toLowerCase();
  if (/\.pdf$/i.test(metadata.name) || mime === 'application/pdf') {
    return {
      ok: false,
      error: { code: 'invalid-pdf', message: 'Содержимое файла не похоже на PDF. Выберите настоящую PDF-выписку или CSV.' },
    };
  }

  const isWholeFile = metadata.size != null
    ? metadata.size <= sample.length
    : sample.length < STATEMENT_SNIFF_BYTES;
  if (looksLikeCsv(sample, isWholeFile)) return { ok: true, format: 'csv' };

  const isDeclaredCsv = /\.csv$/i.test(metadata.name) || mime === 'text/csv' || mime === 'application/csv';
  return {
    ok: false,
    error: isDeclaredCsv
      ? { code: 'invalid-csv', message: 'Содержимое файла не похоже на CSV-таблицу. Выберите другую выписку.' }
      : { code: 'unsupported-format', message: 'Этот формат не поддерживается. Выберите PDF или CSV.' },
  };
}

function looksLikeCsv(bytes: Uint8Array, isWholeFile: boolean): boolean {
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let text = '';
  for (let index = start; index < bytes.length; index += 1) {
    const byte = bytes[index];
    // NUL and binary control characters cannot occur in the supported text CSV format.
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) return false;
    // CSV punctuation is ASCII; leave non-ASCII bytes opaque rather than decoding a cut UTF-8 character.
    text += String.fromCharCode(byte);
  }

  // A format sniff, not a transaction parser: inspect only complete sampled records and no bank schema.
  return [',', ';', '\t'].some((delimiter) => hasConsistentColumns(text, delimiter, isWholeFile));
}

function hasConsistentColumns(text: string, delimiter: string, isWholeFile: boolean): boolean {
  const rows: number[] = [];
  let columns = 1;
  let quoted = false;
  let closedQuote = false;
  let fieldHasContent = false;
  let rowHasContent = false;

  const finishRow = () => {
    if (rowHasContent || columns > 1) rows.push(columns);
    columns = 1;
    closedQuote = false;
    fieldHasContent = false;
    rowHasContent = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') index += 1;
        else {
          quoted = false;
          closedQuote = true;
        }
      }
      continue;
    }
    if (character === delimiter) {
      columns += 1;
      fieldHasContent = false;
      closedQuote = false;
    } else if (character === '\n' || character === '\r') {
      finishRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else if (character === '"') {
      if (fieldHasContent || closedQuote) return false;
      quoted = true;
      fieldHasContent = true;
      rowHasContent = true;
    } else if (character.trim() !== '') {
      if (closedQuote) return false;
      fieldHasContent = true;
      rowHasContent = true;
    }
  }

  if (isWholeFile) {
    if (quoted) return false;
    finishRow();
  }
  return rows.length > 0 && rows[0] > 1 && rows.every((count) => count === rows[0]);
}
