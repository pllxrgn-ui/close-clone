import { describe, expect, test } from 'vitest';
import type { Ast } from '@switchboard/shared';
import { astToDsl, parse } from '@switchboard/shared';
import {
  addChild,
  astToBuilder,
  builderToAst,
  defaultLeafExpr,
  emptyRoot,
  findNode,
  insertAfter,
  leafCount,
  moveChild,
  newGroup,
  newLeaf,
  removeNode,
  rootFromAst,
  setGroupOp,
  unwrapNot,
  updateLeaf,
  wrapInGroup,
  wrapInNot,
  type GroupNode,
  type LeafExpr,
} from './model.ts';

const leafA: LeafExpr = { kind: 'text', query: 'a' };
const leafB: LeafExpr = { kind: 'text', query: 'b' };
const leafC: LeafExpr = { kind: 'text', query: 'c' };

describe('builderToAst', () => {
  test('a single leaf maps to its expr verbatim', () => {
    expect(builderToAst(newLeaf(leafA))).toEqual(leafA);
  });

  test('an empty group is null (no serializable AST)', () => {
    expect(builderToAst(newGroup('and', []))).toBeNull();
  });

  test('a one-child group collapses to that child', () => {
    expect(builderToAst(newGroup('and', [newLeaf(leafA)]))).toEqual(leafA);
  });

  test('groups left-fold into binary chains', () => {
    const group = newGroup('and', [newLeaf(leafA), newLeaf(leafB), newLeaf(leafC)]);
    expect(builderToAst(group)).toEqual({
      kind: 'and',
      left: { kind: 'and', left: leafA, right: leafB },
      right: leafC,
    });
  });

  test('a not wrapping an empty group collapses to null', () => {
    const empty = newGroup('and', []);
    const not = wrapInNot(empty, empty.id);
    expect(builderToAst(not)).toBeNull();
  });

  test('null children are dropped from a group before folding', () => {
    const group = newGroup('or', [newGroup('and', []), newLeaf(leafA), newGroup('and', [])]);
    expect(builderToAst(group)).toEqual(leafA);
  });
});

describe('astToBuilder / rootFromAst', () => {
  test('flattens a left-nested and chain into one n-ary group', () => {
    const ast: Ast = {
      kind: 'and',
      left: { kind: 'and', left: leafA, right: leafB },
      right: leafC,
    };
    const node = astToBuilder(ast);
    expect(node.type).toBe('group');
    if (node.type !== 'group') throw new Error('unreachable');
    expect(node.op).toBe('and');
    expect(node.children.map((c) => c.type)).toEqual(['leaf', 'leaf', 'leaf']);
  });

  test('flattens a right-nested chain too (associativity)', () => {
    const ast: Ast = {
      kind: 'or',
      left: leafA,
      right: { kind: 'or', left: leafB, right: leafC },
    };
    const node = astToBuilder(ast);
    if (node.type !== 'group') throw new Error('expected group');
    expect(node.children).toHaveLength(3);
  });

  test('a mixed-op tree keeps the inner group nested', () => {
    const ast: Ast = {
      kind: 'and',
      left: leafA,
      right: { kind: 'or', left: leafB, right: leafC },
    };
    const node = astToBuilder(ast);
    if (node.type !== 'group') throw new Error('expected group');
    expect(node.op).toBe('and');
    expect(node.children[0]?.type).toBe('leaf');
    expect(node.children[1]?.type).toBe('group');
  });

  test('rootFromAst wraps a non-group root in a group, and builderToAst inverts it', () => {
    const ast: Ast = leafA;
    const root = rootFromAst(ast);
    expect(root.type).toBe('group');
    expect(builderToAst(root)).toEqual(ast);
  });

  test('rootFromAst on a group root round-trips through DSL', () => {
    const ast = parse('status = "Won" and has call within 7d');
    const root = rootFromAst(ast);
    expect(parse(astToDsl(builderToAst(root) as Ast))).toEqual(ast);
  });
});

describe('tree edits (immutable)', () => {
  test('updateLeaf replaces a leaf expr by id without mutating the input', () => {
    const leaf = newLeaf(leafA);
    const root = newGroup('and', [leaf]);
    const next = updateLeaf(root, leaf.id, leafB);
    expect(builderToAst(next)).toEqual(leafB);
    expect(builderToAst(root)).toEqual(leafA); // original unchanged
  });

  test('addChild appends to the target group', () => {
    const root = newGroup('and', [newLeaf(leafA)]);
    const next = addChild(root, root.id, newLeaf(leafB)) as GroupNode;
    expect(next.children).toHaveLength(2);
  });

  test('insertAfter places the new child directly after its sibling', () => {
    const first = newLeaf(leafA);
    const root = newGroup('and', [first, newLeaf(leafC)]);
    const next = insertAfter(root, root.id, first.id, newLeaf(leafB)) as GroupNode;
    expect(next.children.map((c) => builderToAst(c))).toEqual([leafA, leafB, leafC]);
  });

  test('moveChild reorders within the parent group and is a no-op at the edge', () => {
    const a = newLeaf(leafA);
    const b = newLeaf(leafB);
    const root = newGroup('and', [a, b]);
    const down = moveChild(root, a.id, 1) as GroupNode;
    expect(down.children.map((c) => builderToAst(c))).toEqual([leafB, leafA]);
    const noop = moveChild(root, a.id, -1) as GroupNode; // already first
    expect(noop.children.map((c) => builderToAst(c))).toEqual([leafA, leafB]);
  });

  test('removeNode deletes a nested leaf and cascades an emptied not to null', () => {
    const leaf = newLeaf(leafA);
    const inner = newGroup('and', [leaf]);
    const not = wrapInNot(inner, inner.id); // not wraps the group holding the leaf
    const root = newGroup('and', [newLeaf(leafB), not]);
    const removed = removeNode(root, leaf.id) as GroupNode;
    // the not's group is now empty → folds to null → the whole view is just leafB
    expect(builderToAst(removed)).toEqual(leafB);
  });

  test('setGroupOp flips and ⇄ or', () => {
    const root = newGroup('and', [newLeaf(leafA), newLeaf(leafB)]);
    const next = setGroupOp(root, root.id, 'or') as GroupNode;
    expect(next.op).toBe('or');
  });

  test('wrapInNot then unwrapNot restores the original AST', () => {
    const leaf = newLeaf(leafA);
    const root = newGroup('and', [leaf]);
    const negated = wrapInNot(root, leaf.id) as GroupNode;
    expect(builderToAst(negated)).toEqual({ kind: 'not', expr: leafA });
    const wrapper = negated.children[0];
    if (!wrapper || wrapper.type !== 'not') throw new Error('expected not wrapper');
    const restored = unwrapNot(negated, wrapper.id);
    expect(builderToAst(restored)).toEqual(leafA);
  });

  test('wrapInGroup nests a node without changing the AST', () => {
    const leaf = newLeaf(leafA);
    const root = newGroup('or', [leaf, newLeaf(leafB)]);
    const next = wrapInGroup(root, leaf.id, 'and');
    expect(builderToAst(next)).toEqual({ kind: 'or', left: leafA, right: leafB });
  });
});

describe('introspection', () => {
  test('leafCount counts serializable leaves through groups and nots', () => {
    const bLeaf = newLeaf(leafB);
    const root = newGroup('and', [
      newLeaf(leafA),
      wrapInNot(bLeaf, bLeaf.id),
      newGroup('or', [newLeaf(leafC), newLeaf(leafA)]),
    ]);
    expect(leafCount(root)).toBe(4);
  });

  test('findNode locates a nested node by id', () => {
    const target = newLeaf(leafC);
    const root = newGroup('and', [newLeaf(leafA), newGroup('or', [target])]);
    expect(findNode(root, target.id)).toBe(target);
    expect(findNode(root, 'missing')).toBeNull();
  });

  test('emptyRoot and defaultLeafExpr produce a valid single-clause view', () => {
    const root = emptyRoot();
    expect(root.type).toBe('group');
    expect(builderToAst(root)).toEqual(defaultLeafExpr());
  });
});
