import { useState } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { commitImport, dryRunImport, listLeadCustomFields, uploadImport } from '../api/imports.ts';
import { autoMap } from '../lib/automap.ts';
import type { ParsedCsv } from '../lib/csv.ts';
import { Stepper, type WizardStep } from './Stepper.tsx';
import { UploadStep } from './steps/UploadStep.tsx';
import { MapStep } from './steps/MapStep.tsx';
import { PreviewStep } from './steps/PreviewStep.tsx';
import { CommitStep } from './steps/CommitStep.tsx';
import {
  defaultDedupeConfig,
  type CommitResponse,
  type DedupeConfig,
  type DryRunResponse,
  type ImportColumn,
} from '../types.ts';
import '../import.css';

/*
 * The CSV import wizard: upload → map → preview (dry-run) → commit, driving the
 * same C7 routes the real server serves (MSW-backed in the demo). Each network
 * step is a mutation so loading/error states are first-class; the leads board
 * grows on commit because the mock commit writes through to the shared db.
 */

function errMsg(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

export function ImportWizard(): JSX.Element {
  const [step, setStep] = useState<WizardStep>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [columns, setColumns] = useState<ImportColumn[]>([]);
  const [dedupe, setDedupe] = useState<DedupeConfig>(defaultDedupeConfig());
  const [plan, setPlan] = useState<DryRunResponse | null>(null);
  const [commit, setCommit] = useState<CommitResponse | null>(null);

  const customFieldsQuery = useQuery({
    queryKey: ['import', 'lead-custom-fields'],
    queryFn: ({ signal }) => listLeadCustomFields(signal),
    staleTime: 60_000,
  });
  const customFields = customFieldsQuery.data ?? [];

  const uploadMut = useMutation({ mutationFn: (f: File) => uploadImport(f) });
  const dryRunMut = useMutation({
    mutationFn: (id: string) => dryRunImport(id, { mapping: { columns }, dedupeConfig: dedupe }),
  });
  const commitMut = useMutation({ mutationFn: (id: string) => commitImport(id) });

  async function handleContinue(nextFile: File, nextParsed: ParsedCsv): Promise<void> {
    setFile(nextFile);
    setParsed(nextParsed);
    try {
      const res = await uploadMut.mutateAsync(nextFile);
      setImportId(res.id);
      setColumns(autoMap(nextParsed.headers, customFields));
      setStep('map');
    } catch {
      /* uploadMut.error surfaces in the upload step */
    }
  }

  async function runDryRun(): Promise<void> {
    if (importId === null) return;
    try {
      const res = await dryRunMut.mutateAsync(importId);
      setPlan(res);
      setStep('preview');
    } catch {
      /* dryRunMut.error surfaces in the map step */
    }
  }

  async function runCommit(): Promise<void> {
    if (importId === null) return;
    try {
      const res = await commitMut.mutateAsync(importId);
      setCommit(res);
      setStep('commit');
    } catch {
      /* commitMut.error surfaces in the preview step */
    }
  }

  function reset(): void {
    setStep('upload');
    setFile(null);
    setParsed(null);
    setImportId(null);
    setColumns([]);
    setDedupe(defaultDedupeConfig());
    setPlan(null);
    setCommit(null);
    uploadMut.reset();
    dryRunMut.reset();
    commitMut.reset();
  }

  return (
    <div className="imp-page">
      <header className="imp-head">
        <h1 className="imp-title">Import leads</h1>
        <p className="imp-subtitle">
          Bring companies and contacts in from a CSV — mapped, de-duplicated, and previewed before
          anything is written.
        </p>
      </header>

      <Stepper current={step} onGoTo={setStep} locked={step === 'commit'} />

      <section className="imp-stage">
        {step === 'upload' ? (
          <UploadStep
            onContinue={handleContinue}
            isUploading={uploadMut.isPending}
            uploadError={errMsg(uploadMut.error)}
          />
        ) : null}

        {step === 'map' && parsed !== null ? (
          <MapStep
            parsed={parsed}
            columns={columns}
            onColumnsChange={setColumns}
            dedupe={dedupe}
            onDedupeChange={setDedupe}
            customFields={customFields}
            onBack={() => setStep('upload')}
            onRunDryRun={runDryRun}
            isRunning={dryRunMut.isPending}
            dryRunError={errMsg(dryRunMut.error)}
          />
        ) : null}

        {step === 'preview' && plan !== null ? (
          <PreviewStep
            plan={plan}
            onBack={() => setStep('map')}
            onCommit={runCommit}
            isCommitting={commitMut.isPending}
            commitError={errMsg(commitMut.error)}
          />
        ) : null}

        {step === 'commit' && commit !== null ? (
          <CommitStep commit={commit} filename={file?.name ?? 'Your file'} onReset={reset} />
        ) : null}
      </section>
    </div>
  );
}
