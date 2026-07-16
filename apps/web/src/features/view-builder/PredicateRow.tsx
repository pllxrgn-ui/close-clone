/*
 * One predicate row: an attribute picker (builtins + custom.* + Activity +
 * Full-text), a type-constrained comparator, the matching value editor, and the
 * row controls (negate / reorder / duplicate / remove). Everything is a native
 * control and every action is reachable by keyboard — Alt+↑/↓ reorders the row,
 * the control buttons are tab-reachable, and selects/inputs are native.
 */
import { useEffect, useRef } from 'react';
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { BUILTIN_FIELDS, type FieldRef, type FieldType } from '@switchboard/shared';
import { IconButton } from '../../ui/index.ts';
import {
  buildAttributeGroups,
  comparatorLabel,
  comparatorsFor,
  findFieldOption,
  type BuilderCmp,
  type BuilderUser,
  type FieldOption,
} from './catalog.ts';
import {
  ATTR_ACTIVITY,
  ATTR_TEXT,
  attributeLeaf,
  attributeOf,
  comparatorOf,
  withComparator,
} from './leafOps.ts';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, TrashIcon } from './icons.tsx';
import type { LeafExpr } from './model.ts';
import {
  ActivityEditor,
  MembershipEditor,
  ScalarValueEditor,
  TextEditor,
} from './valueEditors.tsx';

export interface PredicateRowProps {
  leaf: LeafExpr;
  fieldOptions: readonly FieldOption[];
  users: readonly BuilderUser[];
  negated: boolean;
  autoFocus?: boolean;
  onChange: (expr: LeafExpr) => void;
  onToggleNegate: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
}

/** Resolve the FieldOption for a leaf's field, synthesizing one if the field is
 *  absent from the catalog (e.g. a saved view referencing a since-removed custom
 *  field, or the catalog failing to load) so the row still round-trips. */
function fieldOptionForLeaf(
  leaf: LeafExpr,
  fieldOptions: readonly FieldOption[],
): FieldOption | undefined {
  if (leaf.kind === 'activity' || leaf.kind === 'text') return undefined;
  const found = findFieldOption(fieldOptions, leaf.field);
  if (found) return found;
  return synthesizeFieldOption(leaf.field);
}

function synthesizeFieldOption(ref: FieldRef): FieldOption {
  if (ref.kind === 'builtin') {
    // FieldRef.name is typed `string` in the shared zod schema, so index safely.
    const type = (BUILTIN_FIELDS as Record<string, FieldType>)[ref.name] ?? 'text';
    return { value: ref.name, ref, type, label: ref.name, group: 'Lead' };
  }
  return {
    value: `custom.${ref.key}`,
    ref,
    type: ref.type,
    label: `custom.${ref.key}`,
    group: 'Custom',
  };
}

export function PredicateRow(props: PredicateRowProps): JSX.Element {
  const { leaf, fieldOptions, users, negated, autoFocus, onChange } = props;
  const attrRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (autoFocus) attrRef.current?.focus();
  }, [autoFocus]);

  const attribute = attributeOf(leaf);
  const currentField = fieldOptionForLeaf(leaf, fieldOptions);
  const attrGroups = buildAttributeGroups(fieldOptions, currentField);

  const onAttribute = (value: string): void => {
    const field =
      fieldOptions.find((o) => o.value === value) ??
      (currentField?.value === value ? currentField : undefined);
    onChange(attributeLeaf(value, field, leaf));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey && e.key === 'ArrowUp' && props.canMoveUp) {
      e.preventDefault();
      props.onMove(-1);
    } else if (e.altKey && e.key === 'ArrowDown' && props.canMoveDown) {
      e.preventDefault();
      props.onMove(1);
    }
  };

  return (
    <div className="sb-vb-row" role="group" aria-label="Condition" onKeyDown={onKeyDown}>
      {negated ? <span className="sb-vb-notchip">not</span> : null}

      <select
        ref={attrRef}
        className="sb-select sb-vb-attr"
        aria-label="Attribute"
        value={attribute}
        onChange={(e) => onAttribute(e.target.value)}
      >
        {attrGroups.map((grp) => (
          <optgroup key={grp.label} label={grp.label}>
            {grp.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
        <optgroup label="Activity & text">
          <option value={ATTR_ACTIVITY}>Activity</option>
          <option value={ATTR_TEXT}>Full-text search</option>
        </optgroup>
      </select>

      {currentField ? (
        <FieldPredicateBody field={currentField} leaf={leaf} users={users} onChange={onChange} />
      ) : leaf.kind === 'activity' ? (
        <span className="sb-vb-valuecell">
          <ActivityEditor leaf={leaf} onChange={onChange} />
        </span>
      ) : leaf.kind === 'text' ? (
        <span className="sb-vb-valuecell">
          <TextEditor query={leaf.query} onChange={(query) => onChange({ kind: 'text', query })} />
        </span>
      ) : null}

      <span className="sb-vb-row__controls">
        <button
          type="button"
          className="sb-vb-not"
          aria-pressed={negated}
          onClick={props.onToggleNegate}
          title={negated ? 'Remove negation' : 'Negate this condition'}
        >
          NOT
        </button>
        <IconButton
          size="sm"
          label="Move condition up"
          disabled={!props.canMoveUp}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label="Move condition down"
          disabled={!props.canMoveDown}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon size={14} />
        </IconButton>
        <IconButton size="sm" label="Duplicate condition" onClick={props.onDuplicate}>
          <CopyIcon size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label="Remove condition"
          disabled={!props.canRemove}
          onClick={props.onRemove}
        >
          <TrashIcon size={14} />
        </IconButton>
      </span>
    </div>
  );
}

function FieldPredicateBody({
  field,
  leaf,
  users,
  onChange,
}: {
  field: FieldOption;
  leaf: LeafExpr;
  users: readonly BuilderUser[];
  onChange: (expr: LeafExpr) => void;
}): JSX.Element {
  const cmp = comparatorOf(leaf) ?? '=';
  const comparators = comparatorsFor(field.type);

  return (
    <>
      <select
        className="sb-select sb-vb-cmp"
        aria-label="Comparator"
        value={cmp}
        onChange={(e) => onChange(withComparator(field, e.target.value as BuilderCmp, leaf))}
      >
        {comparators.map((c) => (
          <option key={c} value={c}>
            {comparatorLabel(c, field.type)}
          </option>
        ))}
      </select>

      {leaf.kind === 'field' ? (
        <span className="sb-vb-valuecell">
          <ScalarValueEditor
            field={field}
            value={leaf.value}
            users={users}
            onChange={(value) =>
              onChange({ kind: 'field', field: field.ref, cmp: leaf.cmp, value })
            }
          />
        </span>
      ) : null}
      {leaf.kind === 'membership' ? (
        <span className="sb-vb-valuecell sb-vb-valuecell--wide">
          <MembershipEditor
            field={field}
            values={leaf.values}
            users={users}
            onChange={(values) => onChange({ kind: 'membership', field: field.ref, values })}
          />
        </span>
      ) : null}
      {/* presence predicates need no value editor */}
    </>
  );
}
