import type { JSX } from 'react';
import { Button, Checkbox, Field, Input, Select } from '../../../../ui/index.ts';
import type { ParsedCsv } from '../../lib/csv.ts';
import type { LeadCustomField } from '../../api/imports.ts';
import {
  CONTACT_FIELD_LABELS,
  IGNORE_TARGET,
  LEAD_FIELD_LABELS,
  mappingReadiness,
} from '../../lib/mapping.ts';
import { ArrowLeftIcon, ArrowRightIcon } from '../../icons.tsx';
import {
  CONTACT_TARGET_FIELDS,
  DEDUPE_ACTIONS,
  LEAD_TARGET_FIELDS,
  type DedupeAction,
  type DedupeConfig,
  type ImportColumn,
} from '../../types.ts';

/*
 * Step 02 — assign every source column to a lead/contact/custom field (smart
 * auto-mapped on arrival), then choose how duplicates are matched and resolved.
 * "Run dry run" is gated by mappingReadiness: a Lead → Name column and only
 * known custom fields, so the plan the next step shows is one the engine accepts.
 */

const ACTION_LABELS: Record<DedupeAction, string> = {
  skip: 'Skip the duplicate row',
  'merge-fields': 'Merge into the existing lead',
  'create-anyway': 'Import as a new lead anyway',
};

export interface MapStepProps {
  parsed: ParsedCsv;
  columns: ImportColumn[];
  onColumnsChange: (columns: ImportColumn[]) => void;
  dedupe: DedupeConfig;
  onDedupeChange: (dedupe: DedupeConfig) => void;
  customFields: LeadCustomField[];
  onBack: () => void;
  onRunDryRun: () => void;
  isRunning: boolean;
  dryRunError: string | null;
}

export function MapStep({
  parsed,
  columns,
  onColumnsChange,
  dedupe,
  onDedupeChange,
  customFields,
  onBack,
  onRunDryRun,
  isRunning,
  dryRunError,
}: MapStepProps): JSX.Element {
  const customKeys = new Set(customFields.map((f) => f.key));
  const readiness = mappingReadiness(columns, customKeys);

  function setTarget(index: number, target: string): void {
    onColumnsChange(columns.map((c, i) => (i === index ? { source: c.source, target } : c)));
  }
  function setMatch(key: keyof DedupeConfig['matchOn'], value: boolean): void {
    onDedupeChange({ ...dedupe, matchOn: { ...dedupe.matchOn, [key]: value } });
  }

  return (
    <div className="imp-panel">
      <div className="imp-map-scroll">
        <table className="imp-table imp-map">
          <thead>
            <tr>
              <th scope="col">Column</th>
              <th scope="col">First value</th>
              <th scope="col">Maps to</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col, i) => {
              const sample = parsed.rows[0]?.[i] ?? '';
              const ignored = col.target === IGNORE_TARGET;
              return (
                <tr key={`${col.source}-${i}`} data-ignored={ignored || undefined}>
                  <th scope="row" className="imp-map__source">
                    {col.source || <span className="imp-muted">(unnamed)</span>}
                  </th>
                  <td className="imp-map__sample">
                    {sample ? sample : <span className="imp-muted">—</span>}
                  </td>
                  <td className="imp-map__target">
                    <Select
                      aria-label={`Map column ${col.source || `#${i + 1}`}`}
                      value={col.target}
                      onChange={(e) => setTarget(i, e.target.value)}
                    >
                      <option value={IGNORE_TARGET}>Ignore this column</option>
                      <optgroup label="Lead">
                        {LEAD_TARGET_FIELDS.map((f) => (
                          <option key={f} value={`lead.${f}`}>
                            {LEAD_FIELD_LABELS[f]}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Contact">
                        {CONTACT_TARGET_FIELDS.map((f) => (
                          <option key={f} value={`contact.${f}`}>
                            {CONTACT_FIELD_LABELS[f]}
                          </option>
                        ))}
                      </optgroup>
                      {customFields.length > 0 ? (
                        <optgroup label="Custom">
                          {customFields.map((f) => (
                            <option key={f.key} value={`custom.${f.key}`}>
                              {f.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : null}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <fieldset className="imp-dedupe">
        <legend className="imp-section-label">Duplicate handling</legend>
        <p className="imp-hint">Match incoming rows against existing leads by:</p>
        <div className="imp-dedupe__matches">
          <Checkbox
            label="Contact email"
            checked={dedupe.matchOn.email}
            onChange={(e) => setMatch('email', e.target.checked)}
          />
          <Checkbox
            label="Company domain"
            checked={dedupe.matchOn.domain}
            onChange={(e) => setMatch('domain', e.target.checked)}
          />
          <Checkbox
            label="Similar company name"
            checked={dedupe.matchOn.fuzzyName}
            onChange={(e) => setMatch('fuzzyName', e.target.checked)}
          />
        </div>

        <div className="imp-dedupe__grid">
          <Field label="When a duplicate is found">
            <Select
              value={dedupe.action}
              onChange={(e) =>
                onDedupeChange({ ...dedupe, action: e.target.value as DedupeAction })
              }
            >
              {DEDUPE_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a]}
                </option>
              ))}
            </Select>
          </Field>
          {dedupe.matchOn.fuzzyName ? (
            <Field label="Name sensitivity" hint="0 = loose, 1 = exact. 0.45 is a good default.">
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={String(dedupe.fuzzyNameThreshold)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const clamped = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.45;
                  onDedupeChange({ ...dedupe, fuzzyNameThreshold: clamped });
                }}
              />
            </Field>
          ) : null}
        </div>
      </fieldset>

      {!readiness.ready ? (
        <ul className="imp-issues" role="status">
          {readiness.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {dryRunError !== null ? (
        <p className="imp-inline-error" role="alert">
          {dryRunError}
        </p>
      ) : null}

      <div className="imp-actions imp-actions--split">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeftIcon size={16} />
          Back
        </Button>
        <Button
          variant="primary"
          onClick={onRunDryRun}
          loading={isRunning}
          disabled={!readiness.ready}
        >
          Run dry run
          <ArrowRightIcon size={16} />
        </Button>
      </div>
    </div>
  );
}
