import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const header = 'date,description,amount\n';
const row = '2026-09-01,Synthetic,-1.00\n';
const limit = 10 * 1024 * 1024;
const rows = Math.ceil((limit + 1 - Buffer.byteLength(header)) / Buffer.byteLength(row));
const file = Buffer.from(header + row.repeat(rows));
writeFileSync(join(directory, 'fixtures', 'oversize.csv'), file);
console.log(`Created fixtures/oversize.csv (${file.length} bytes; limit ${limit})`);
