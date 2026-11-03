import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_STATEMENT_BYTES,
  STATEMENT_SNIFF_BYTES,
  validateStatementContent,
  validateStatementSize,
} from './validateStatementFile.ts';

const fixture = (name) => readFileSync(new URL(`../../../../../mobile-engineer-kit/fixtures/${name}`, import.meta.url));
const inspectText = (text, metadata = { name: 'statement.csv' }) => {
  const bytes = Buffer.from(text);
  return validateStatementContent({ ...metadata, size: bytes.length }, bytes);
};

test('the 10 MiB limit is inclusive and metadata can reject an oversized file before reading', () => {
  assert.equal(validateStatementSize(MAX_STATEMENT_BYTES), null);
  assert.equal(validateStatementSize(MAX_STATEMENT_BYTES + 1)?.code, 'too-large');
  assert.equal(validateStatementSize(0)?.code, 'empty');
  for (const size of [-1, NaN, Infinity, 1.5]) {
    assert.equal(validateStatementSize(size)?.code, 'invalid-size');
  }
  assert.equal(validateStatementSize(undefined), null);
  assert.equal(validateStatementSize(null), null);
  assert.equal(validateStatementContent({ name: 'large.csv', size: MAX_STATEMENT_BYTES + 1 }, new Uint8Array()).error.code, 'too-large');
});

test('accepts real fixture bytes and determines PDF from content despite misleading metadata', () => {
  const pdf = fixture('statement.pdf');
  const csv = fixture('statement.csv');
  assert.deepEqual(validateStatementContent({ name: 'statement.pdf', size: pdf.length }, pdf.subarray(0, STATEMENT_SNIFF_BYTES)), { ok: true, format: 'pdf' });
  assert.deepEqual(validateStatementContent({ name: 'statement.csv', size: csv.length, mimeType: 'application/octet-stream' }, csv), { ok: true, format: 'csv' });
  assert.deepEqual(validateStatementContent({ name: 'misnamed.csv', size: pdf.length, mimeType: 'text/csv' }, pdf), { ok: true, format: 'pdf' });
});

test('rejects the supplied spoofed PDF and a PDF label hiding CSV content', () => {
  const spoofed = fixture('spoofed.pdf');
  assert.equal(validateStatementContent({ name: 'spoofed.pdf', mimeType: 'application/pdf', size: spoofed.length }, spoofed).error.code, 'invalid-pdf');
  assert.equal(inspectText('a,b\n1,2\n', { name: 'renamed.PDF' }).error.code, 'invalid-pdf');
  assert.equal(inspectText('a,b\n1,2\n', { name: 'unknown', mimeType: 'application/pdf; charset=utf-8' }).error.code, 'invalid-pdf');
  assert.equal(inspectText('junk %PDF-1.7\n', { name: 'statement.pdf' }).error.code, 'invalid-pdf');
});

test('accepts BOM, CRLF, non-ASCII text, quoted fields, escaped quotes and semicolon CSV', () => {
  for (const text of [
    '\ufeffдата,описание,сумма\r\n2026-01-01,Кофе,10\r\n',
    'date;description;amount\n2026-01-01;"Shop; café";10\n',
    'date,description,amount\n2026-01-01,"Shop, \"\"quoted\"\"",10\n',
    'date,description,amount\n2026-01-01,"Two\nlines",10',
    'date\tdescription\tamount\n2026-01-01\tShop\t10\n',
    'column,other',
  ]) assert.deepEqual(inspectText(text), { ok: true, format: 'csv' });
});

test('rejects empty, binary, plain text and malformed CSV samples without trusting the name', () => {
  assert.equal(inspectText('').error.code, 'empty');
  for (const text of ['\ufeff', '   \n', 'not a table\njust text', 'a,b\n1,2\0', 'a,b\n"unclosed,field', 'a,b\n1,2,3\n', 'a,b\n"value"junk,2\n']) {
    assert.equal(inspectText(text).error.code, 'invalid-csv');
  }
  assert.equal(inspectText('\x89PNG\r\n\x1a\n', { name: 'image.png', mimeType: 'image/png' }).error.code, 'unsupported-format');
});

test('a bounded prefix ignores the incomplete final record including a cut UTF-8 character', () => {
  const head = Buffer.from('a,b\n1,"');
  const prefix = Buffer.concat([head, Buffer.alloc(STATEMENT_SNIFF_BYTES - head.length - 1, 0x61), Buffer.from([0xd0])]);
  assert.deepEqual(validateStatementContent({ name: 'statement.csv', size: STATEMENT_SNIFF_BYTES + 20 }, prefix), { ok: true, format: 'csv' });
  assert.equal(validateStatementContent({ name: 'statement.csv', size: prefix.length }, prefix).error.code, 'invalid-csv');
});

test('sniff never depends on bytes beyond its 8 KiB sample', () => {
  const prefix = Buffer.concat([Buffer.from('a,b\n'), Buffer.alloc(STATEMENT_SNIFF_BYTES - 4, 0x20)]);
  const bytes = Buffer.concat([prefix, Buffer.from([0])]);
  assert.deepEqual(validateStatementContent({ name: 'statement.csv', size: bytes.length }, bytes), { ok: true, format: 'csv' });
});
