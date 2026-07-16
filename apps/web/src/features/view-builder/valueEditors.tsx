/*
 * Value editors for each predicate kind, constrained by field type (CONTRACTS
 * §C3). Every editor is a native, keyboard-first control (select / input /
 * button) so the whole builder is operable without a mouse. Editors emit the
 * exact AST value shape; the parser is the arbiter (round-trip suite enforces).
 */
import type { JSX } from 'react';
import type {
  ActivityTypeDsl,
  MembershipValue,
  RelativeUnit,
  ScalarValue,
} from '@switchboard/shared';
import { Input, Select } from '../../ui/index.ts';
import { IconButton } from '../../ui/index.ts';
import {
  ACTIVITY_OPTIONS,
  activityLabel,
  UNIT_OPTIONS,
  unitLabel,
  type BuilderUser,
  type FieldOption,
} from './catalog.ts';
import { setActivityType, setActivityWithin } from './leafOps.ts';
import { PlusIcon, XIcon } from './icons.tsx';
import type { LeafExpr } from './model.ts';

type ActivityLeaf = Extract<LeafExpr, { kind: 'activity' }>;

const todayIso = (): string => new Date().toISOString().slice(0, 10);

// ── Scalar value (field predicate) ────────────────────────────────────────────

export function ScalarValueEditor({
  field,
  value,
  users,
  onChange,
}: {
  field: FieldOption;
  value: ScalarValue;
  users: readonly BuilderUser[];
  onChange: (v: ScalarValue) => void;
}): JSX.Element {
  switch (field.type) {
    case 'number':
      return (
        <Input
          type="number"
          className="sb-vb-value sb-vb-value--num"
          aria-label="Value"
          value={value.kind === 'number' ? String(value.value) : ''}
          onChange={(e) => onChange({ kind: 'number', value: toNumber(e.target.value) })}
        />
      );
    case 'bool':
      return (
        <Select
          className="sb-vb-value"
          aria-label="Value"
          value={value.kind === 'bool' && value.value ? 'true' : 'false'}
          onChange={(e) => onChange({ kind: 'bool', value: e.target.value === 'true' })}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </Select>
      );
    case 'user':
      return (
        <Select
          className="sb-vb-value"
          aria-label="Value"
          value={value.kind === 'string' ? value.value : ''}
          onChange={(e) => onChange({ kind: 'string', value: e.target.value })}
        >
          <option value="">Select a user…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      );
    case 'select':
      if (field.options && field.options.length > 0) {
        return (
          <Select
            className="sb-vb-value"
            aria-label="Value"
            value={value.kind === 'string' ? value.value : ''}
            onChange={(e) => onChange({ kind: 'string', value: e.target.value })}
          >
            <option value="">Select a value…</option>
            {field.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </Select>
        );
      }
      return (
        <Input
          className="sb-vb-value"
          aria-label="Value"
          value={value.kind === 'string' ? value.value : ''}
          onChange={(e) => onChange({ kind: 'string', value: e.target.value })}
        />
      );
    case 'date':
      return <DateValueEditor value={value} onChange={onChange} />;
    case 'text':
    default:
      return (
        <Input
          className="sb-vb-value"
          aria-label="Value"
          value={value.kind === 'string' ? value.value : ''}
          onChange={(e) => onChange({ kind: 'string', value: e.target.value })}
        />
      );
  }
}

type DateMode = 'exact' | 'ago' | 'today' | 'this_week' | 'this_month';

function dateModeOf(value: ScalarValue): DateMode {
  if (value.kind === 'reldate') {
    return value.rel.form === 'relative' ? 'ago' : value.rel.name;
  }
  return 'exact';
}

function DateValueEditor({
  value,
  onChange,
}: {
  value: ScalarValue;
  onChange: (v: ScalarValue) => void;
}): JSX.Element {
  const mode = dateModeOf(value);
  const setMode = (next: DateMode): void => {
    if (next === 'exact') {
      onChange({ kind: 'date', value: value.kind === 'date' ? value.value : todayIso() });
    } else if (next === 'ago') {
      const rel =
        value.kind === 'reldate' && value.rel.form === 'relative'
          ? value.rel
          : { form: 'relative' as const, n: 7, unit: 'd' as RelativeUnit };
      onChange({ kind: 'reldate', rel });
    } else {
      onChange({ kind: 'reldate', rel: { form: 'named', name: next } });
    }
  };

  return (
    <span className="sb-vb-date">
      <Select
        className="sb-vb-datemode"
        aria-label="Date mode"
        value={mode}
        onChange={(e) => setMode(e.target.value as DateMode)}
      >
        <option value="exact">on date</option>
        <option value="ago">N units ago</option>
        <option value="today">today</option>
        <option value="this_week">this week</option>
        <option value="this_month">this month</option>
      </Select>
      {mode === 'exact' && value.kind === 'date' ? (
        <Input
          type="date"
          className="sb-vb-value"
          aria-label="Date"
          value={value.value.slice(0, 10)}
          onChange={(e) => onChange({ kind: 'date', value: e.target.value })}
        />
      ) : null}
      {mode === 'ago' && value.kind === 'reldate' && value.rel.form === 'relative' ? (
        <RelativeAmount
          n={value.rel.n}
          unit={value.rel.unit}
          onChange={(n, unit) => onChange({ kind: 'reldate', rel: { form: 'relative', n, unit } })}
        />
      ) : null}
    </span>
  );
}

function RelativeAmount({
  n,
  unit,
  onChange,
}: {
  n: number;
  unit: RelativeUnit;
  onChange: (n: number, unit: RelativeUnit) => void;
}): JSX.Element {
  return (
    <span className="sb-vb-rel">
      <Input
        type="number"
        min={0}
        className="sb-vb-value sb-vb-value--num"
        aria-label="Amount"
        value={String(n)}
        onChange={(e) => onChange(toNonNegInt(e.target.value), unit)}
      />
      <Select
        className="sb-vb-unit"
        aria-label="Unit"
        value={unit}
        onChange={(e) => onChange(n, e.target.value as RelativeUnit)}
      >
        {UNIT_OPTIONS.map((u) => (
          <option key={u} value={u}>
            {unitLabel(u)}
          </option>
        ))}
      </Select>
      <span className="sb-vb-suffix">ago</span>
    </span>
  );
}

// ── Membership (`field in (...)`) ─────────────────────────────────────────────

export function MembershipEditor({
  field,
  values,
  users,
  onChange,
}: {
  field: FieldOption;
  values: readonly MembershipValue[];
  users: readonly BuilderUser[];
  onChange: (v: MembershipValue[]) => void;
}): JSX.Element {
  const add = (v: MembershipValue): void => onChange([...values, v]);
  const removeAt = (idx: number): void => onChange(values.filter((_, i) => i !== idx));
  const hasMe = values.some((v) => v.kind === 'me');

  return (
    <span className="sb-vb-members">
      <ul className="sb-vb-chips" aria-label="Selected values">
        {values.map((v, idx) => (
          <li key={`${chipKey(v)}-${idx}`} className="sb-vb-chip">
            <span className="sb-vb-chip__text">{chipLabel(v, users)}</span>
            <IconButton
              size="sm"
              className="sb-vb-chip__x"
              label={`Remove ${chipLabel(v, users)}`}
              disabled={values.length <= 1}
              onClick={() => removeAt(idx)}
            >
              <XIcon size={12} />
            </IconButton>
          </li>
        ))}
      </ul>
      <MembershipAdder field={field} users={users} hasMe={hasMe} onAdd={add} />
    </span>
  );
}

function MembershipAdder({
  field,
  users,
  hasMe,
  onAdd,
}: {
  field: FieldOption;
  users: readonly BuilderUser[];
  hasMe: boolean;
  onAdd: (v: MembershipValue) => void;
}): JSX.Element {
  if (field.type === 'user') {
    return (
      <span className="sb-vb-add">
        <Select
          className="sb-vb-add__select"
          aria-label="Add a user"
          value=""
          onChange={(e) => {
            if (e.target.value) onAdd({ kind: 'string', value: e.target.value });
          }}
        >
          <option value="">Add a user…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <button
          type="button"
          className="sb-vb-me"
          aria-pressed={hasMe}
          disabled={hasMe}
          onClick={() => onAdd({ kind: 'me' })}
        >
          + me
        </button>
      </span>
    );
  }
  if (field.type === 'select' && field.options && field.options.length > 0) {
    return (
      <Select
        className="sb-vb-add__select"
        aria-label="Add a value"
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd({ kind: 'string', value: e.target.value });
        }}
      >
        <option value="">Add a value…</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </Select>
    );
  }
  return <FreeAdder numeric={field.type === 'number'} onAdd={onAdd} />;
}

function FreeAdder({
  numeric,
  onAdd,
}: {
  numeric: boolean;
  onAdd: (v: MembershipValue) => void;
}): JSX.Element {
  const commit = (raw: string, reset: () => void): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    onAdd(numeric ? { kind: 'number', value: toNumber(trimmed) } : { kind: 'string', value: raw });
    reset();
  };
  return (
    <span className="sb-vb-add">
      <Input
        type={numeric ? 'number' : 'text'}
        className="sb-vb-add__input"
        aria-label="Add a value"
        placeholder="Add a value…"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(e.currentTarget.value, () => {
              e.currentTarget.value = '';
            });
          }
        }}
      />
      <IconButton
        label="Add value"
        size="sm"
        onClick={(e) => {
          const input = e.currentTarget.parentElement?.querySelector('input');
          if (input) commit(input.value, () => (input.value = ''));
        }}
      >
        <PlusIcon size={14} />
      </IconButton>
    </span>
  );
}

// ── Activity predicate ────────────────────────────────────────────────────────

export function ActivityEditor({
  leaf,
  onChange,
}: {
  leaf: ActivityLeaf;
  onChange: (l: ActivityLeaf) => void;
}): JSX.Element {
  const within = leaf.within;
  return (
    <span className="sb-vb-activity">
      <Select
        className="sb-vb-actop"
        aria-label="Has or does not have"
        value={leaf.op}
        onChange={(e) => onChange({ ...leaf, op: e.target.value as 'has' | 'no' })}
      >
        <option value="has">has</option>
        <option value="no">has no</option>
      </Select>
      <Select
        className="sb-vb-acttype"
        aria-label="Activity type"
        value={leaf.activity}
        onChange={(e) => onChange(setActivityType(leaf, e.target.value as ActivityTypeDsl))}
      >
        {ACTIVITY_OPTIONS.map((a) => (
          <option key={a} value={a}>
            {activityLabel(a)}
          </option>
        ))}
      </Select>
      {leaf.activity === 'in_sequence' ? (
        <Input
          className="sb-vb-seqname"
          aria-label="Sequence name"
          placeholder="Sequence name"
          value={leaf.sequenceName ?? ''}
          onChange={(e) => onChange({ ...leaf, sequenceName: e.target.value })}
        />
      ) : null}
      <label className="sb-vb-within-toggle">
        <input
          type="checkbox"
          checked={within !== undefined}
          onChange={(e) =>
            onChange(setActivityWithin(leaf, e.target.checked ? { n: 30, unit: 'd' } : null))
          }
        />
        <span>within</span>
      </label>
      {within ? (
        <span className="sb-vb-rel">
          <Input
            type="number"
            min={0}
            className="sb-vb-value sb-vb-value--num"
            aria-label="Within amount"
            value={String(within.n)}
            onChange={(e) =>
              onChange(setActivityWithin(leaf, { n: toNonNegInt(e.target.value), unit: within.unit }))
            }
          />
          <Select
            className="sb-vb-unit"
            aria-label="Within unit"
            value={within.unit}
            onChange={(e) =>
              onChange(setActivityWithin(leaf, { n: within.n, unit: e.target.value as RelativeUnit }))
            }
          >
            {UNIT_OPTIONS.map((u) => (
              <option key={u} value={u}>
                {unitLabel(u)}
              </option>
            ))}
          </Select>
        </span>
      ) : null}
    </span>
  );
}

// ── Full-text (`matches "..."`) ───────────────────────────────────────────────

export function TextEditor({
  query,
  onChange,
}: {
  query: string;
  onChange: (q: string) => void;
}): JSX.Element {
  return (
    <Input
      className="sb-vb-value sb-vb-value--wide"
      aria-label="Search text"
      placeholder="Full-text search…"
      value={query}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toNumber(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
function toNonNegInt(raw: string): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function chipKey(v: MembershipValue): string {
  return v.kind === 'me' ? 'me' : v.kind === 'number' ? `n${v.value}` : `s${v.value}`;
}
function chipLabel(v: MembershipValue, users: readonly BuilderUser[]): string {
  if (v.kind === 'me') return 'me';
  if (v.kind === 'number') return String(v.value);
  if (v.kind === 'bool') return v.value ? 'true' : 'false';
  const user = users.find((u) => u.id === v.value);
  return user ? user.name : v.value === '' ? '(empty)' : v.value;
}
