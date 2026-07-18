import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, JSX } from 'react';
import { Button, ErrorState } from '../../../../ui/index.ts';
import { CsvParseError, parseCsv, sampleCsv, type ParsedCsv } from '../../lib/csv.ts';
import { readFileText } from '../../lib/file.ts';
import { MAX_UPLOAD_BYTES } from '../../api/imports.ts';
import { countNoun } from '../../lib/format.ts';
import { ArrowRightIcon, DownloadIcon, FileCsvIcon, RemoveIcon, UploadIcon } from '../../icons.tsx';

/*
 * Step 01 — choose a CSV (drag-drop or browse, or the built-in sample) and see
 * the detected shape before uploading. The file is parsed client-side purely to
 * preview columns/rows and to catch an empty or malformed file early; the real
 * dry-run re-parses server-side. "Upload & continue" POSTs the multipart body.
 */

const PREVIEW_ROWS = 5;

export interface UploadStepProps {
  onContinue: (file: File, parsed: ParsedCsv) => void;
  isUploading: boolean;
  uploadError: string | null;
}

interface Selection {
  file: File;
  parsed: ParsedCsv;
}

export function UploadStep({ onContinue, isUploading, uploadError }: UploadStepProps): JSX.Element {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function accept(file: File): Promise<void> {
    setParseError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setSelection(null);
      setParseError('That file is over the 5 MB import limit. Split it and try again.');
      return;
    }
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setSelection(null);
      setParseError("Couldn't read that file. Make sure it's a text CSV.");
      return;
    }
    try {
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setSelection(null);
        setParseError(
          'This file has a header but no data rows. Add at least one row and re-export.',
        );
        return;
      }
      setSelection({ file, parsed });
    } catch (err) {
      setSelection(null);
      setParseError(
        err instanceof CsvParseError
          ? `This file isn't valid CSV: ${err.message}`
          : 'This file could not be parsed as CSV.',
      );
    }
  }

  function onInputChange(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file) void accept(file);
  }

  function onDrop(e: DragEvent<HTMLLabelElement>): void {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void accept(file);
  }

  function useSample(): void {
    const file = new File([sampleCsv()], 'switchboard-sample.csv', { type: 'text/csv' });
    void accept(file);
  }

  function reset(): void {
    setSelection(null);
    setParseError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  if (parseError !== null) {
    return (
      <div className="imp-panel">
        <ErrorState
          title="That file won't import"
          description={parseError}
          onRetry={reset}
          retryLabel="Choose another file"
          actions={
            <Button variant="ghost" onClick={useSample}>
              Use the sample instead
            </Button>
          }
        />
      </div>
    );
  }

  if (selection === null) {
    return (
      <div className="imp-panel">
        <label
          className="imp-drop"
          data-dragover={dragOver || undefined}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="imp-drop__input"
            onChange={onInputChange}
          />
          <UploadIcon size={28} className="imp-drop__icon" />
          <span className="imp-drop__lead">
            Drag a CSV here, or <span className="imp-drop__browse">browse</span>
          </span>
          <span className="imp-drop__hint">
            One row per contact. Company, website, and email map automatically.
          </span>
        </label>
        <div className="imp-panel__aside">
          <span className="imp-hint">No file handy?</span>
          <Button variant="ghost" size="sm" onClick={useSample}>
            <DownloadIcon size={14} />
            Use a sample file
          </Button>
        </div>
      </div>
    );
  }

  const { file, parsed } = selection;
  const previewRows = parsed.rows.slice(0, PREVIEW_ROWS);
  return (
    <div className="imp-panel">
      <div className="imp-filecard">
        <FileCsvIcon size={20} className="imp-filecard__icon" />
        <div className="imp-filecard__meta">
          <span className="imp-filecard__name">{file.name}</span>
          <span className="imp-filecard__stat">
            {countNoun(parsed.headers.length, 'column')} · {countNoun(parsed.rows.length, 'row')}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={reset}>
          <RemoveIcon size={14} />
          Remove
        </Button>
      </div>

      <div className="imp-preview-scroll" role="group" aria-label="File preview">
        <table className="imp-table imp-table--preview">
          <thead>
            <tr>
              {parsed.headers.map((h, i) => (
                <th key={`${h}-${i}`} scope="col">
                  {h || <span className="imp-muted">(unnamed)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, r) => (
              <tr key={r}>
                {parsed.headers.map((_h, c) => (
                  <td key={c}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {parsed.rows.length > PREVIEW_ROWS ? (
        <p className="imp-hint">
          Showing {PREVIEW_ROWS} of {parsed.rows.length} rows.
        </p>
      ) : null}

      {uploadError !== null ? (
        <p className="imp-inline-error" role="alert">
          {uploadError}
        </p>
      ) : null}

      <div className="imp-actions">
        <Button variant="primary" loading={isUploading} onClick={() => onContinue(file, parsed)}>
          Upload &amp; continue
          <ArrowRightIcon size={16} />
        </Button>
      </div>
    </div>
  );
}
