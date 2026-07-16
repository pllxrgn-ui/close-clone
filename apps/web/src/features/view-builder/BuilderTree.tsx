/*
 * Recursive renderer for the builder tree. Dispatches group / not / leaf and
 * wires each control to the right node id:
 *   - move / remove / duplicate act on the GROUP CHILD (the outer node — the
 *     `not` wrapper when a clause is negated), because those are group-level ops;
 *   - the value editor edits the LEAF expr;
 *   - negate wraps the leaf/group; un-negate unwraps the `not`.
 * All chrome is achromatic (design law: color budget is state only); AND/OR is
 * conveyed by text, never hue.
 */
import type { JSX } from 'react';
import { Button } from '../../ui/index.ts';
import { IconButton } from '../../ui/index.ts';
import type { BuilderUser, FieldOption } from './catalog.ts';
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, GroupIcon, PlusIcon, TrashIcon } from './icons.tsx';
import type { BuilderNode, Combinator, GroupNode, LeafExpr } from './model.ts';
import { PredicateRow } from './PredicateRow.tsx';

export interface BuilderActions {
  updateLeaf: (id: string, expr: LeafExpr) => void;
  addCondition: (groupId: string) => void;
  addGroup: (groupId: string) => void;
  remove: (id: string) => void;
  move: (id: string, delta: number) => void;
  setOp: (groupId: string, op: Combinator) => void;
  negate: (id: string) => void;
  unnegate: (notId: string) => void;
  duplicate: (id: string) => void;
}

export interface TreeCtx {
  fieldOptions: readonly FieldOption[];
  users: readonly BuilderUser[];
  focusId: string | null;
  actions: BuilderActions;
}

/** Controls that a group child (row or subgroup) exposes to its parent. */
interface ChildControls {
  onMove: (delta: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRemove: () => void;
  canRemove: boolean;
  onDuplicate: () => void;
  onToggleNegate: () => void;
  negated: boolean;
}

export function BuilderRoot({ root, ctx }: { root: GroupNode; ctx: TreeCtx }): JSX.Element {
  return <GroupView node={root} ctx={ctx} isRoot />;
}

function GroupView({
  node,
  ctx,
  isRoot,
  controls,
}: {
  node: GroupNode;
  ctx: TreeCtx;
  isRoot: boolean;
  controls?: ChildControls;
}): JSX.Element {
  const count = node.children.length;
  return (
    <div
      className={cxGroup(isRoot, controls?.negated)}
      role="group"
      aria-label={isRoot ? 'Filter conditions' : 'Condition group'}
    >
      <div className="sb-vb-group__head">
        {controls?.negated ? <span className="sb-vb-notchip">not</span> : null}
        <div className="sb-vb-combo" role="group" aria-label="Match mode">
          <button
            type="button"
            className="sb-vb-combo__opt"
            aria-pressed={node.op === 'and'}
            onClick={() => ctx.actions.setOp(node.id, 'and')}
          >
            All
          </button>
          <button
            type="button"
            className="sb-vb-combo__opt"
            aria-pressed={node.op === 'or'}
            onClick={() => ctx.actions.setOp(node.id, 'or')}
          >
            Any
          </button>
          <span className="sb-vb-combo__hint">
            {node.op === 'and' ? 'match all conditions' : 'match any condition'}
          </span>
        </div>

        <div className="sb-vb-group__actions">
          <Button size="sm" variant="ghost" onClick={() => ctx.actions.addCondition(node.id)}>
            <PlusIcon size={14} /> Condition
          </Button>
          <Button size="sm" variant="ghost" onClick={() => ctx.actions.addGroup(node.id)}>
            <GroupIcon size={14} /> Group
          </Button>
          {controls ? (
            <>
              <button
                type="button"
                className="sb-vb-not"
                aria-pressed={controls.negated}
                onClick={controls.onToggleNegate}
                title={controls.negated ? 'Remove negation' : 'Negate this group'}
              >
                NOT
              </button>
              <IconButton
                size="sm"
                label="Move group up"
                disabled={!controls.canMoveUp}
                onClick={() => controls.onMove(-1)}
              >
                <ArrowUpIcon size={14} />
              </IconButton>
              <IconButton
                size="sm"
                label="Move group down"
                disabled={!controls.canMoveDown}
                onClick={() => controls.onMove(1)}
              >
                <ArrowDownIcon size={14} />
              </IconButton>
              <IconButton size="sm" label="Duplicate group" onClick={controls.onDuplicate}>
                <CopyIcon size={14} />
              </IconButton>
              <IconButton
                size="sm"
                label="Remove group"
                disabled={!controls.canRemove}
                onClick={controls.onRemove}
              >
                <TrashIcon size={14} />
              </IconButton>
            </>
          ) : null}
        </div>
      </div>

      {count === 0 ? (
        <p className="sb-vb-group__empty">
          No conditions yet. Add a condition to start filtering.
        </p>
      ) : (
        <ul className="sb-vb-group__children">
          {node.children.map((child, index) => (
            <li key={child.id} className="sb-vb-group__child">
              {index > 0 ? (
                <span className="sb-vb-joiner" aria-hidden="true">
                  {node.op === 'and' ? 'and' : 'or'}
                </span>
              ) : null}
              <NodeView node={child} index={index} siblingCount={count} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeView({
  node,
  index,
  siblingCount,
  ctx,
}: {
  node: BuilderNode;
  index: number;
  siblingCount: number;
  ctx: TreeCtx;
}): JSX.Element {
  const base = {
    canMoveUp: index > 0,
    canMoveDown: index < siblingCount - 1,
    onMove: (delta: number) => ctx.actions.move(node.id, delta),
    onRemove: () => ctx.actions.remove(node.id),
    canRemove: true,
    onDuplicate: () => ctx.actions.duplicate(node.id),
  };

  // Bare leaf.
  if (node.type === 'leaf') {
    return (
      <PredicateRow
        leaf={node.expr}
        fieldOptions={ctx.fieldOptions}
        users={ctx.users}
        negated={false}
        autoFocus={ctx.focusId === node.id}
        onChange={(expr) => ctx.actions.updateLeaf(node.id, expr)}
        onToggleNegate={() => ctx.actions.negate(node.id)}
        {...base}
      />
    );
  }

  // Bare group.
  if (node.type === 'group') {
    return (
      <GroupView
        node={node}
        ctx={ctx}
        isRoot={false}
        controls={{ ...base, negated: false, onToggleNegate: () => ctx.actions.negate(node.id) }}
      />
    );
  }

  // `not` wrapper: negation lives on the OUTER node; move/remove/duplicate still
  // target it (node.id), so a negated clause reorders as a unit.
  const child = node.child;
  const negControls = { ...base, negated: true, onToggleNegate: () => ctx.actions.unnegate(node.id) };

  if (child.type === 'leaf') {
    return (
      <PredicateRow
        leaf={child.expr}
        fieldOptions={ctx.fieldOptions}
        users={ctx.users}
        negated
        autoFocus={ctx.focusId === node.id}
        onChange={(expr) => ctx.actions.updateLeaf(child.id, expr)}
        onToggleNegate={negControls.onToggleNegate}
        {...base}
      />
    );
  }
  if (child.type === 'group') {
    return <GroupView node={child} ctx={ctx} isRoot={false} controls={negControls} />;
  }
  // not-of-not (double negation) — render a framed wrapper.
  return (
    <div className="sb-vb-notframe" role="group" aria-label="Negated">
      <div className="sb-vb-notframe__head">
        <span className="sb-vb-notchip">not</span>
        <IconButton size="sm" label="Remove negation" onClick={negControls.onToggleNegate}>
          <TrashIcon size={14} />
        </IconButton>
      </div>
      <NodeView node={child} index={0} siblingCount={1} ctx={ctx} />
    </div>
  );
}

function cxGroup(isRoot: boolean, negated?: boolean): string {
  return ['sb-vb-group', isRoot ? 'sb-vb-group--root' : 'sb-vb-group--nested', negated ? 'is-negated' : '']
    .filter(Boolean)
    .join(' ');
}
