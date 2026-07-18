/*
 * Client-side CSV reader for the import wizard's upload preview + the demo-mode
 * planner. A small RFC 4180 tokenizer (quoted fields, doubled-quote escapes,
 * embedded commas/newlines, CRLF or LF) — enough to read the files a rep exports
 * from a spreadsheet, and to feed the mock dry-run the same records the real
 * server-side parser (`services/imports/csv.ts`) would stream. Pure + synchronous
 * so it unit-tests without a DOM and runs inside an MSW handler.
 */

/** A malformed document (today: an unterminated quoted field). */
export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/**
 * Tokenize `text` into records (the header is simply the first record). A blank
 * line becomes a single empty-cell record `['']` — a real (empty) data row the
 * planner reports as `empty`, never silently dropped. A trailing line terminator
 * does not emit a phantom record.
 */
export function parseCsvRecords(text: string): string[][] {
  if (text.length === 0) return [];
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Swallow CRLF as one terminator; a lone CR also ends the record.
      endRecord();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvParseError('Unterminated quoted field — check for a missing closing quote.');
  }
  // Flush the final record unless the file ended exactly on a terminator.
  if (field.length > 0 || record.length > 0) endRecord();
  return records;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Split a document into its header record and the data rows beneath it. */
export function parseCsv(text: string): ParsedCsv {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = parseCsvRecords(stripped);
  if (records.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = records;
  return { headers: headers ?? [], rows };
}

/**
 * A ready-to-run demo file so a first-time operator can drive the whole wizard
 * with zero prep. Deliberately exercises every disposition the ledger shows:
 * fresh companies (create), a repeat of an earlier row (in-file dedupe), a
 * malformed email (error), a row with no company name (error), and a blank line
 * (empty). Company tokens avoid the fixture vocabulary so fresh rows don't
 * accidentally fuzzy-match a seeded lead.
 */
export function sampleCsv(): string {
  return [
    'Company,Website,Contact,Email,Title,Phone,Segment,Notes',
    'Marlowe Textiles,marlowe-textiles.example.com,Dana Cole,dana@marlowe-textiles.example.com,VP Operations,+12065550101,Mid-Market,Referred by trade show',
    'Kestrel Provisions,kestrel-provisions.example.com,Amir Haddad,amir@kestrel-provisions.example.com,Founder,+12065550142,SMB,Inbound demo request',
    'Amberflow Diagnostics,amberflow-dx.example.com,Lena Ортега,lena@amberflow-dx.example.com,Head of Procurement,,Enterprise,Renewal in Q4',
    // Repeat of row 1 (same email/domain) → in-file dedupe.
    'Marlowe Textiles,marlowe-textiles.example.com,Dana Cole,dana@marlowe-textiles.example.com,VP Operations,+12065550101,Mid-Market,Duplicate export line',
    // Malformed email → error row.
    'Sundial Ceramics,sundial-ceramics.example.com,Ruth Alvarez,not-an-email,Owner,+12065550188,SMB,Typo in the source sheet',
    // No company name and no dedupe match → error row.
    ',,Unknown Person,person@nowhere.example.com,,,,Orphan contact with no account',
    'Bramblewood Press,bramblewood-press.example.com,Otis Frame,otis@bramblewood-press.example.com,Managing Editor,+12065550170,Mid-Market,Trade publication',
    '',
    'Tidewater Robotics,tidewater-robotics.example.com,Priya Nair,priya@tidewater-robotics.example.com,CTO,+12065550133,Enterprise,Met at conference',
  ].join('\r\n');
}
