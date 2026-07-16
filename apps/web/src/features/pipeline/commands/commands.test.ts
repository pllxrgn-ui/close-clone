import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePipelineCommands } from './commands.ts';
import { registerMover, setActiveOpp } from '../state/boardInteraction.ts';
import type { MoveDir } from '../state/boardInteraction.ts';

/*
 * usePipelineCommands bridges the board's focused deal into the app-wide command
 * palette. Two contract points matter most: it offers commands ONLY while a deal
 * is focused (so the palette never shows a command that would no-op), and each
 * command routes through the mover the mounted board installs — surviving the
 * board being gone without throwing.
 */

const noop = (): void => {};

afterEach(() => {
  // Unmount subscribers first, then clear the module-scope active deal, so the
  // external-store update lands with no listeners (no act warning) and no state
  // leaks into the next test.
  cleanup();
  setActiveOpp(null);
});

describe('usePipelineCommands', () => {
  test('offers no commands when no deal is focused (never a dead command)', () => {
    setActiveOpp(null);
    const { result } = renderHook(() => usePipelineCommands(noop));
    expect(result.current).toEqual([]);
  });

  test('offers advance / back / won / lost for the focused deal, labeled with its name', () => {
    const { result } = renderHook(() => usePipelineCommands(noop));
    act(() => setActiveOpp({ id: 'o1', label: 'Acme Robotics' }));

    expect(result.current.map((c) => c.title)).toEqual([
      'Advance: Acme Robotics',
      'Move back: Acme Robotics',
      'Mark won: Acme Robotics',
      'Mark lost: Acme Robotics',
    ]);
    expect(result.current.map((c) => c.id)).toEqual([
      'pipeline:next',
      'pipeline:prev',
      'pipeline:won',
      'pipeline:lost',
    ]);
    expect(result.current.every((c) => c.group === 'Actions')).toBe(true);
  });

  test('running a command drives the installed mover, then closes the palette', () => {
    const moves: MoveDir[] = [];
    const unregister = registerMover((dir) => moves.push(dir));
    const onRun = vi.fn();
    const { result } = renderHook(() => usePipelineCommands(onRun));
    act(() => setActiveOpp({ id: 'o1', label: 'Acme' }));

    const [advance, , won] = result.current;
    advance?.run();
    won?.run();

    expect(moves).toEqual(['next', 'won']);
    expect(onRun).toHaveBeenCalledTimes(2);
    unregister();
  });

  test('a command is safe once the board (its mover) is gone — no throw, still closes', () => {
    // No mover registered (board unmounted): runMove is a no-op but the command
    // must not throw and must still close the palette.
    const onRun = vi.fn();
    const { result } = renderHook(() => usePipelineCommands(onRun));
    act(() => setActiveOpp({ id: 'o1', label: 'Acme' }));

    const [advance] = result.current;
    expect(() => advance?.run()).not.toThrow();
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  test('commands disappear again once the deal is unfocused', () => {
    const { result } = renderHook(() => usePipelineCommands(noop));
    act(() => setActiveOpp({ id: 'o1', label: 'Acme' }));
    expect(result.current).toHaveLength(4);

    act(() => setActiveOpp(null));
    expect(result.current).toEqual([]);
  });
});
