import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Lamp, LampRail, LAMP_STATES, LAMP_META, LAMP_LEGEND } from './Lamp.tsx';

afterEach(cleanup);

describe('Lamp', () => {
  test('names itself from the state by default (role=img)', () => {
    render(<Lamp state="reply" />);
    const lamp = screen.getByRole('img', { name: 'Reply' });
    expect(lamp).toHaveClass('sb-lamp', 'sb-lamp--reply');
  });

  test('accepts a custom accessible label', () => {
    render(<Lamp state="dnc" label="Blocked contact" />);
    expect(screen.getByRole('img', { name: 'Blocked contact' })).toBeInTheDocument();
  });

  // failure path: a decorative lamp must leave the a11y tree entirely
  test('decorative lamp is hidden from assistive tech', () => {
    const { container } = render(<Lamp state="live" decorative />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    const el = container.querySelector('.sb-lamp--live');
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  test('reply/live pulse by default; pulse=false marks data-static', () => {
    const { container: on } = render(<Lamp state="live" />);
    expect(on.querySelector('.sb-lamp--live')).not.toHaveAttribute('data-static');
    cleanup();
    const { container: off } = render(<Lamp state="live" pulse={false} />);
    expect(off.querySelector('.sb-lamp--live')).toHaveAttribute('data-static');
  });

  // failure path: non-active states never carry the static flag (they never pulse)
  test('a non-pulsing state ignores pulse=false (no data-static)', () => {
    const { container } = render(<Lamp state="overdue" pulse={false} />);
    expect(container.querySelector('.sb-lamp--overdue')).not.toHaveAttribute('data-static');
  });

  test('size overrides the dot diameter', () => {
    const { container } = render(<Lamp state="idle" size={14} />);
    expect(container.querySelector('.sb-lamp--idle')).toHaveStyle({
      width: '14px',
      height: '14px',
    });
  });
});

describe('LampRail', () => {
  test('renders a labelled rail with a track and a node', () => {
    const { container } = render(<LampRail state="seq" />);
    const rail = screen.getByRole('img', { name: 'Sequence' });
    expect(rail).toHaveClass('sb-lamp-rail', 'sb-lamp-rail--seq');
    expect(container.querySelector('.sb-lamp-rail__track')).toBeInTheDocument();
    expect(container.querySelector('.sb-lamp-rail__node')).toHaveClass('sb-lamp--seq');
  });

  // failure path: decorative rail is out of the a11y tree
  test('decorative rail is hidden from assistive tech', () => {
    render(<LampRail state="reply" decorative />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('lamp registry', () => {
  test('exposes exactly the six law states with metadata', () => {
    expect(LAMP_STATES).toEqual(['reply', 'overdue', 'seq', 'dnc', 'live', 'idle']);
    expect(LAMP_LEGEND).toHaveLength(6);
    for (const state of LAMP_STATES) {
      expect(LAMP_META[state].label.length).toBeGreaterThan(0);
      expect(LAMP_META[state].meaning.length).toBeGreaterThan(0);
    }
  });
});
