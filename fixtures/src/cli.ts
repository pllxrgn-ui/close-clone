import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOLDEN,
  LATENCY,
  countDataset,
  datasetHash,
  generateDataset,
  generateLeadBundles,
} from './generate.ts';
import type { DatasetCounts } from './types.ts';

const OUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../out');

interface Manifest {
  seed: string;
  format: 'json' | 'ndjson';
  counts: DatasetCounts;
  contentHash: string;
  generatedFrom: string;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Batched ndjson writer — bounded memory for the 100k latency set. */
class NdjsonWriter {
  private readonly fd: number;
  private readonly hash: Hash;
  private readonly label: string;
  private buffer = '';
  private pending = 0;

  constructor(path: string, hash: Hash, label: string) {
    this.fd = openSync(path, 'w');
    this.hash = hash;
    this.label = label;
  }

  write(record: unknown): void {
    const line = `${JSON.stringify(record)}\n`;
    this.buffer += line;
    this.hash.update(`${this.label}:${line}`);
    if ((this.pending += 1) >= 1000) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length > 0) {
      writeSync(this.fd, this.buffer);
      this.buffer = '';
      this.pending = 0;
    }
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

function writeGolden(): void {
  const dir = join(OUT_ROOT, 'golden');
  ensureDir(dir);
  const dataset = generateDataset(GOLDEN.count, GOLDEN.seed);
  const counts = countDataset(dataset);

  writeFileSync(join(dir, 'leads.json'), JSON.stringify(dataset.leads, null, 2));
  writeFileSync(join(dir, 'contacts.json'), JSON.stringify(dataset.contacts, null, 2));
  writeFileSync(join(dir, 'opportunities.json'), JSON.stringify(dataset.opportunities, null, 2));
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(dataset.tasks, null, 2));
  writeFileSync(join(dir, 'activities.json'), JSON.stringify(dataset.activities, null, 2));

  const manifest: Manifest = {
    seed: GOLDEN.seed,
    format: 'json',
    counts,
    contentHash: datasetHash(dataset),
    generatedFrom: 'fixtures/src/generate.ts',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`[fixtures] golden → ${dir}`);
  console.log(`[fixtures] counts ${JSON.stringify(counts)}`);
  console.log(`[fixtures] contentHash ${manifest.contentHash}`);
}

function writeLatency(): void {
  const dir = join(OUT_ROOT, 'latency');
  ensureDir(dir);
  const hash = createHash('sha256');

  const leads = new NdjsonWriter(join(dir, 'leads.ndjson'), hash, 'lead');
  const contacts = new NdjsonWriter(join(dir, 'contacts.ndjson'), hash, 'contact');
  const opportunities = new NdjsonWriter(join(dir, 'opportunities.ndjson'), hash, 'opportunity');
  const tasks = new NdjsonWriter(join(dir, 'tasks.ndjson'), hash, 'task');
  const activities = new NdjsonWriter(join(dir, 'activities.ndjson'), hash, 'activity');

  const counts: DatasetCounts = {
    leads: 0,
    contacts: 0,
    opportunities: 0,
    tasks: 0,
    activities: 0,
  };

  for (const bundle of generateLeadBundles(LATENCY.count, LATENCY.seed)) {
    leads.write(bundle.lead);
    counts.leads += 1;
    for (const c of bundle.contacts) {
      contacts.write(c);
      counts.contacts += 1;
    }
    for (const o of bundle.opportunities) {
      opportunities.write(o);
      counts.opportunities += 1;
    }
    for (const t of bundle.tasks) {
      tasks.write(t);
      counts.tasks += 1;
    }
    for (const act of bundle.activities) {
      activities.write(act);
      counts.activities += 1;
    }
  }

  for (const w of [leads, contacts, opportunities, tasks, activities]) {
    w.close();
  }

  const manifest: Manifest = {
    seed: LATENCY.seed,
    format: 'ndjson',
    counts,
    contentHash: hash.digest('hex'),
    generatedFrom: 'fixtures/src/generate.ts',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`[fixtures] latency → ${dir}`);
  console.log(`[fixtures] counts ${JSON.stringify(counts)}`);
  console.log(`[fixtures] contentHash ${manifest.contentHash}`);
}

function main(argv: readonly string[]): void {
  const wantGolden = argv.includes('--golden');
  const wantLatency = argv.includes('--latency');

  if (!wantGolden && !wantLatency) {
    console.error('usage: generate (--golden | --latency)');
    process.exit(1);
  }

  if (wantGolden) {
    writeGolden();
  }
  if (wantLatency) {
    writeLatency();
  }
}

main(process.argv.slice(2));
