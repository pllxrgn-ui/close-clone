/**
 * Deterministic CSV import fixtures (Task 4f). Run with:
 *   node fixtures/imports/generate.ts
 * Regenerating with the same seed reproduces byte-identical files (a `.gitattributes`
 * pins `*.csv -text` so git never rewrites the line endings the parser tests rely on).
 *
 * Emits:
 *   - leads-10k.csv  — 10,000 data rows for the scale/latency + count test. Shaped
 *     to exercise build-guide §8 "10k-row CSV imports with SANE DEDUPE": ~half the
 *     rows are exact in-file duplicates (skipped), a fixed block are bad-number
 *     rows (errors), and the rest are unique creates — so the aggregate counts are
 *     exactly known (see EXPECTED_10K) and the dedupe path is genuinely stressed.
 *   - messy.csv      — small hand-shaped mess: UTF-8 BOM, a duplicate header, a
 *     quoted comma, a quoted embedded CRLF, a bad number, a bad date, an invalid
 *     email, and a fully blank row.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ROW_TOTAL = 10_000;
const CREATE_END = 5_000; // rows 1..5000 → unique creates
const DUP_START = CREATE_END + 1; // rows 5001..9900 → exact dup of rows 1..4900 (in-file skip)
const DUP_END = 9_900;
const BAD_NUMBER_START = DUP_END + 1; // rows 9901..10000 → invalid Employees (error rows)
const BAD_NUMBER_END = ROW_TOTAL;

/** The counts the 10k fixture must produce (asserted by engine.test.ts). */
export const EXPECTED_10K = {
  totalRows: 10_000,
  leadsCreated: 5_000, // 1..5000
  contactsCreated: 5_000,
  dedupeSkipped: 4_900, // 5001..9900 dup rows 1..4900 by email
  errorRows: 100, // 9901..10000
} as const;

/** Deterministic PRNG (mulberry32) seeded with a constant. */
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INDUSTRIES = ['SaaS', 'Fintech', 'Healthcare', 'Logistics', 'Retail'];

function generate10k(): string {
  const rand = mulberry32(0x5346_4d54); // "SFMT"
  const lines: string[] = ['Company,Website,Email,Contact,Title,Industry,Employees'];
  for (let i = 1; i <= ROW_TOTAL; i += 1) {
    const industry = INDUSTRIES[Math.floor(rand() * INDUSTRIES.length)] ?? 'SaaS';
    if (i >= DUP_START && i <= DUP_END) {
      const j = i - (DUP_START - 1); // dup of row j in 1..4900
      lines.push(
        `Company ${j},https://company${j}.example.com,contact${j}@company${j}.example.com,Contact ${j},Rep,${industry},${100 + j}`,
      );
      continue;
    }
    const employees = i >= BAD_NUMBER_START && i <= BAD_NUMBER_END ? 'lots' : String(100 + i);
    lines.push(
      `Company ${i},https://company${i}.example.com,contact${i}@company${i}.example.com,Contact ${i},Rep,${industry},${employees}`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Assembled with explicit BOM + mixed CRLF/LF so parser edge cases are real. */
function generateMessy(): Buffer {
  const BOM = '﻿';
  const parts = [
    `${BOM}Company,Website,Email,Employees,Signed,Notes,Company`, // duplicate "Company" header
    'Acme,https://acme.com,alice@acme.com,250,2025-01-31,"Hello, world",DUP', // quoted comma
    '"Globex, Inc.",globex.io,bob@globex.io,bad,2025-13-40,"line one\r\nline two",X', // bad number + bad date + quoted CRLF
    '', // fully blank row
    'Initech,,not-an-email,42,2025-06-15,plain,Y', // invalid email
  ];
  // CRLF between records except the embedded CRLF already inside the Globex Notes.
  return Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
}

function main(): void {
  writeFileSync(join(HERE, 'leads-10k.csv'), generate10k(), 'utf8');
  writeFileSync(join(HERE, 'messy.csv'), generateMessy());
  process.stdout.write('wrote leads-10k.csv + messy.csv\n');
}

// Only write files when executed directly — importing (for EXPECTED_10K in tests)
// must be side-effect free.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
