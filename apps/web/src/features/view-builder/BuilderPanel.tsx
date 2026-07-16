/*
 * The visual builder panel: owns the transient focus-on-add state and binds the
 * pure model edits to the root-change callback. The root AST lives one level up
 * (ViewBuilderPage) so the DSL editor and preview read the same source of truth.
 */
import { useState } from 'react';
import type { JSX } from 'react';
import type { BuilderUser, FieldOption } from './catalog.ts';
import { BuilderRoot, type BuilderActions } from './BuilderTree.tsx';
import {
  addChild,
  duplicateNode,
  moveChild,
  newGroup,
  newLeaf,
  removeNode,
  setGroupOp,
  unwrapNot,
  updateLeaf,
  wrapInNot,
  type BuilderNode,
  type Combinator,
  type GroupNode,
  type LeafExpr,
} from './model.ts';

function asGroup(node: BuilderNode | null): GroupNode {
  return node && node.type === 'group' ? node : newGroup('and', []);
}

export function BuilderPanel({
  root,
  onRootChange,
  fieldOptions,
  users,
  catalogError,
}: {
  root: GroupNode;
  onRootChange: (next: GroupNode) => void;
  fieldOptions: readonly FieldOption[];
  users: readonly BuilderUser[];
  catalogError?: boolean;
}): JSX.Element {
  const [focusId, setFocusId] = useState<string | null>(null);

  const actions: BuilderActions = {
    updateLeaf: (id: string, expr: LeafExpr) => onRootChange(asGroup(updateLeaf(root, id, expr))),
    addCondition: (groupId: string) => {
      const leaf = newLeaf();
      onRootChange(asGroup(addChild(root, groupId, leaf)));
      setFocusId(leaf.id);
    },
    addGroup: (groupId: string) => {
      const child = newLeaf();
      const group = newGroup('and', [child]);
      onRootChange(asGroup(addChild(root, groupId, group)));
      setFocusId(child.id);
    },
    remove: (id: string) => onRootChange(asGroup(removeNode(root, id))),
    move: (id: string, delta: number) => onRootChange(asGroup(moveChild(root, id, delta))),
    setOp: (groupId: string, op: Combinator) =>
      onRootChange(asGroup(setGroupOp(root, groupId, op))),
    negate: (id: string) => onRootChange(asGroup(wrapInNot(root, id))),
    unnegate: (notId: string) => onRootChange(asGroup(unwrapNot(root, notId))),
    duplicate: (id: string) => onRootChange(asGroup(duplicateNode(root, id))),
  };

  return (
    <div className="sb-vb-builder">
      {catalogError ? (
        <p className="sb-vb-catalog-warn" role="status">
          Custom fields couldn’t be loaded — built-in fields only. The rest of the builder works
          normally.
        </p>
      ) : null}

      <BuilderRoot root={root} ctx={{ fieldOptions, users, focusId, actions }} />

      <p className="sb-vb-kbdhint">
        Tab moves between controls · <kbd className="sb-kbd">Alt</kbd> +{' '}
        <kbd className="sb-kbd">↑</kbd>/<kbd className="sb-kbd">↓</kbd> reorders a focused condition
      </p>
    </div>
  );
}
