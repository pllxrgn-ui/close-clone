import type { ComponentProps, JSX } from 'react';
import { cx } from '../lib/cx.ts';
import { Modal } from './Modal.tsx';

export interface DrawerProps extends Omit<ComponentProps<typeof Modal>, 'backdropClassName'> {
  side?: 'right' | 'left';
  /**
   * Skip the slide entrance (0ms). REQUIRED for keyboard-summoned drawers —
   * the motion law forbids animating keyboard-initiated actions (§4).
   */
  instant?: boolean;
}

/**
 * Edge-docked dialog for flow-initiated work (compose, enroll, detail-edit)
 * that keeps the board visible behind it. Same accessibility contract as
 * Modal (it IS Modal: focus trap, Escape, focus restore) with a slide-in
 * entrance — CSS-only, so reduced-motion keeps the fade and drops the slide.
 * Exit is intentionally instant: Modal unmounts on close (matching the
 * palette/cheat-sheet pattern), and a dismissal should never make the user
 * wait — the §4 "exits ≈ 75%" rule is read as a ceiling, not a mandate.
 */
export function Drawer({
  side = 'right',
  instant = false,
  className,
  ...rest
}: DrawerProps): JSX.Element | null {
  return (
    <Modal
      backdropClassName={cx('sb-overlay--drawer', side === 'left' && 'sb-overlay--drawer-left')}
      className={cx(
        'sb-drawer',
        side === 'left' && 'sb-drawer--left',
        instant && 'sb-drawer--instant',
        className,
      )}
      {...rest}
    />
  );
}
