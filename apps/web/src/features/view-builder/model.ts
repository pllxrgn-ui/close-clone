/*
 * The builder tree model — the single source of truth shared by the visual
 * builder and the raw-DSL editor (CONTRACTS §C3: "builder UI reads/writes the
 * same AST"). A `BuilderNode` is an editor-ergonomic view of the DSL AST:
 * n-ary and/or groups (nicer to edit than the AST's binary `and`/`or` chains),
 * explicit `not` wrappers, and leaf predicates that ARE the AST leaf nodes
 * verbatim (no parallel predicate model to drift out of sync).
 *
 * The two conversions are the contract:
 *   builderToAst(node)  → left-folds groups into the AST's binary form
 *   astToBuilder(ast)   → flattens same-op binary chains into n-ary groups
 *
 * Because leaves ARE AST nodes and `builderToAst` emits exactly the canonical
 * left-associative shape the parser reconstructs, the round-trip
 *   parse(astToDsl(builderToAst(b))) ≡ builderToAst(b)
 * reduces to the shared package's proven `parse(astToDsl(a)) ≡ a`. This is the
 * property exercised in model.roundtrip.test.ts.
 */
import type { Ast, Expr } from '@switchboard/shared';

/** The five predicate leaf shapes of the AST (everything except and/or/not). */
export type LeafExpr = Extract<
  Expr,
  { kind: 'field' | 'presence' | 'membership' | 'activity' | 'text' }
>;

export type Combinator = 'and' | 'or';

export interface GroupNode {
  readonly id: string;
  readonly type: 'group';
  readonly op: Combinator;
  readonly children: readonly BuilderNode[];
}

export interface NotNode {
  readonly id: string;
  readonly type: 'not';
  readonly child: BuilderNode;
}

export interface LeafNode {
  readonly id: string;
  readonly type: 'leaf';
  readonly expr: LeafExpr;
}

export type BuilderNode = GroupNode | NotNode | LeafNode;

// ── IDs ─────────────────────────────────────────────────────────────────────
// Node ids exist only for React keys and focus/selection; they never appear in
// the AST, so AST equality (deep-equal) is unaffected by them.

let idCounter = 0;

/** A process-unique, stable node id. Prefixed so it never collides with data. */
export function newId(): string {
  idCounter += 1;
  return `n${idCounter.toString(36)}`;
}

// ── Leaf defaults ─────────────────────────────────────────────────────────────

/** The default predicate a fresh row starts as: `name contains ""`. Always
 *  type-valid, so `builderToAst` never yields an unserializable leaf. */
export function defaultLeafExpr(): LeafExpr {
  return {
    kind: 'field',
    field: { kind: 'builtin', name: 'name' },
    cmp: 'contains',
    value: { kind: 'string', value: '' },
  };
}

export function newLeaf(expr: LeafExpr = defaultLeafExpr()): LeafNode {
  return { id: newId(), type: 'leaf', expr };
}

export function newGroup(op: Combinator = 'and', children?: readonly BuilderNode[]): GroupNode {
  return { id: newId(), type: 'group', op, children: children ?? [newLeaf()] };
}

// ── builderToAst ──────────────────────────────────────────────────────────────

/**
 * Fold a builder tree into a DSL AST. Returns `null` for an empty tree (a group
 * with no serializable children) — an empty view has no DSL, so callers gate
 * save/preview on a non-null result. Groups left-fold so `[a,b,c]` under `and`
 * becomes `((a and b) and c)`, the exact shape the parser rebuilds.
 */
export function builderToAst(node: BuilderNode): Ast | null {
  switch (node.type) {
    case 'leaf':
      return node.expr;
    case 'not': {
      const inner = builderToAst(node.child);
      return inner === null ? null : { kind: 'not', expr: inner };
    }
    case 'group': {
      const parts: Ast[] = [];
      for (const child of node.children) {
        const ast = builderToAst(child);
        if (ast !== null) parts.push(ast);
      }
      if (parts.length === 0) return null;
      return parts.reduce((left, right) => ({ kind: node.op, left, right }));
    }
  }
}

// ── astToBuilder ──────────────────────────────────────────────────────────────

/** Collect the operands of a same-op binary chain (both nesting directions). */
function flatten(ast: Expr, op: 'and' | 'or'): Expr[] {
  const out: Expr[] = [];
  const walk = (node: Expr): void => {
    if (node.kind === op) {
      walk(node.left);
      walk(node.right);
    } else {
      out.push(node);
    }
  };
  walk(ast);
  return out;
}

/** Hydrate a builder tree from a DSL AST (inverse of {@link builderToAst} up to
 *  associativity: same-op chains flatten into one n-ary group). */
export function astToBuilder(ast: Ast): BuilderNode {
  switch (ast.kind) {
    case 'and':
    case 'or':
      return {
        id: newId(),
        type: 'group',
        op: ast.kind,
        children: flatten(ast, ast.kind).map(astToBuilder),
      };
    case 'not':
      return { id: newId(), type: 'not', child: astToBuilder(ast.expr) };
    default:
      return { id: newId(), type: 'leaf', expr: ast };
  }
}

/** The editor keeps the root as a group so top-level clauses can be added; a
 *  non-group AST root is wrapped in a single-child `and` group (which
 *  `builderToAst` collapses back, preserving the round-trip). */
export function rootFromAst(ast: Ast): GroupNode {
  const node = astToBuilder(ast);
  if (node.type === 'group') return node;
  return { id: newId(), type: 'group', op: 'and', children: [node] };
}

/** A fresh, empty root group (one default clause) for the "new view" flow. */
export function emptyRoot(): GroupNode {
  return newGroup('and', [newLeaf()]);
}

// ── Immutable tree edits (all return a new tree; never mutate in place) ────────

/** Replace the node with `id` by `fn(node)`; unchanged if `id` is absent. */
export function replaceNode(
  node: BuilderNode,
  id: string,
  fn: (n: BuilderNode) => BuilderNode,
): BuilderNode {
  if (node.id === id) return fn(node);
  if (node.type === 'group') {
    return { ...node, children: node.children.map((c) => replaceNode(c, id, fn)) };
  }
  if (node.type === 'not') {
    return { ...node, child: replaceNode(node.child, id, fn) };
  }
  return node;
}

/** Remove the node with `id` anywhere in the tree. Removing a `not`'s only
 *  child collapses the `not` too (cascades up). The root is never removed. */
export function removeNode(node: BuilderNode, id: string): BuilderNode | null {
  if (node.id === id) return null;
  if (node.type === 'group') {
    const children: BuilderNode[] = [];
    for (const c of node.children) {
      const kept = removeNode(c, id);
      if (kept !== null) children.push(kept);
    }
    return { ...node, children };
  }
  if (node.type === 'not') {
    const child = removeNode(node.child, id);
    return child === null ? null : { ...node, child };
  }
  return node;
}

/** Update a leaf's predicate expression by id. */
export function updateLeaf(node: BuilderNode, id: string, expr: LeafExpr): BuilderNode {
  return replaceNode(node, id, (n) => (n.type === 'leaf' ? { ...n, expr } : n));
}

/** Set a group's combinator (and ⇄ or) by id. */
export function setGroupOp(node: BuilderNode, id: string, op: Combinator): BuilderNode {
  return replaceNode(node, id, (n) => (n.type === 'group' ? { ...n, op } : n));
}

/** Append a child to the group with `id`. */
export function addChild(node: BuilderNode, groupId: string, child: BuilderNode): BuilderNode {
  return replaceNode(node, groupId, (n) =>
    n.type === 'group' ? { ...n, children: [...n.children, child] } : n,
  );
}

/** Insert `child` immediately after the sibling `afterId` inside `groupId`. */
export function insertAfter(
  node: BuilderNode,
  groupId: string,
  afterId: string,
  child: BuilderNode,
): BuilderNode {
  return replaceNode(node, groupId, (n) => {
    if (n.type !== 'group') return n;
    const idx = n.children.findIndex((c) => c.id === afterId);
    if (idx === -1) return { ...n, children: [...n.children, child] };
    const children = [...n.children];
    children.splice(idx + 1, 0, child);
    return { ...n, children };
  });
}

/** Move the child at `childId` within its parent group by `delta` (±1…). No-op
 *  if the move would leave the bounds of the group. */
export function moveChild(node: BuilderNode, childId: string, delta: number): BuilderNode {
  if (node.type === 'group') {
    const idx = node.children.findIndex((c) => c.id === childId);
    if (idx !== -1) {
      const target = idx + delta;
      if (target < 0 || target >= node.children.length) return node;
      const children = [...node.children];
      const [moved] = children.splice(idx, 1);
      if (moved) children.splice(target, 0, moved);
      return { ...node, children: children.map((c) => moveChild(c, childId, delta)) };
    }
    return { ...node, children: node.children.map((c) => moveChild(c, childId, delta)) };
  }
  if (node.type === 'not') {
    return { ...node, child: moveChild(node.child, childId, delta) };
  }
  return node;
}

/** Wrap the node with `id` in a `not` (negate). Returns a new tree. */
export function wrapInNot(node: BuilderNode, id: string): BuilderNode {
  return replaceNode(node, id, (n) => ({ id: newId(), type: 'not', child: n }));
}

/** Remove a `not` wrapper with `id`, promoting its child in place. */
export function unwrapNot(node: BuilderNode, id: string): BuilderNode {
  return replaceNode(node, id, (n) => (n.type === 'not' ? n.child : n));
}

/** Wrap the node with `id` in a fresh group of the given op (used to nest). */
export function wrapInGroup(node: BuilderNode, id: string, op: Combinator = 'and'): BuilderNode {
  return replaceNode(node, id, (n) => ({ id: newId(), type: 'group', op, children: [n] }));
}

/** Deep-clone a subtree with fresh ids (its predicate exprs are immutable and
 *  shared by reference). */
export function cloneWithNewIds(node: BuilderNode): BuilderNode {
  switch (node.type) {
    case 'leaf':
      return { id: newId(), type: 'leaf', expr: node.expr };
    case 'not':
      return { id: newId(), type: 'not', child: cloneWithNewIds(node.child) };
    case 'group':
      return {
        id: newId(),
        type: 'group',
        op: node.op,
        children: node.children.map(cloneWithNewIds),
      };
  }
}

/** Insert a fresh-id clone of the node with `id` directly after it in its parent
 *  group. No-op if `id` is not a group child (e.g. the root). */
export function duplicateNode(node: BuilderNode, id: string): BuilderNode {
  if (node.type === 'group') {
    const idx = node.children.findIndex((c) => c.id === id);
    if (idx !== -1) {
      const target = node.children[idx];
      if (!target) return node;
      const children = [...node.children];
      children.splice(idx + 1, 0, cloneWithNewIds(target));
      return { ...node, children };
    }
    return { ...node, children: node.children.map((c) => duplicateNode(c, id)) };
  }
  if (node.type === 'not') {
    return { ...node, child: duplicateNode(node.child, id) };
  }
  return node;
}

// ── Introspection ─────────────────────────────────────────────────────────────

export function findNode(node: BuilderNode, id: string): BuilderNode | null {
  if (node.id === id) return node;
  if (node.type === 'group') {
    for (const c of node.children) {
      const hit = findNode(c, id);
      if (hit) return hit;
    }
  } else if (node.type === 'not') {
    return findNode(node.child, id);
  }
  return null;
}

/** Count serializable leaves — used to gate save/preview and empty states. */
export function leafCount(node: BuilderNode): number {
  switch (node.type) {
    case 'leaf':
      return 1;
    case 'not':
      return leafCount(node.child);
    case 'group':
      return node.children.reduce((sum, c) => sum + leafCount(c), 0);
  }
}
