import type { ComponentProps, JSX } from 'react';
import { cx } from '../lib/cx.ts';
import { Modal } from './Modal.tsx';

export interface DrawerProps extends Omit<ComponentProps<typeof Modal>, 'backdropClassName'> {
  side?: 'right' | 'left';
}

/**
 * Edge-docked dialog for flow-initiated work (compose, enroll, detail-edit)
 * that keeps the board visible behind it. Same accessibility contract as
 * Modal (it IS Modal: focus trap, Escape, focus restore) with a slide-in
 * entrance — CSS-only, so reduced-motion keeps the fade and drops the slide.
 */
export function Drawer({ side = 'right', className, ...rest }: DrawerProps): JSX.Element | null {
  return (
    <Modal
      backdropClassName={cx('sb-overlay--drawer', side === 'left' && 'sb-overlay--drawer-left')}
      className={cx('sb-drawer', side === 'left' && 'sb-drawer--left', className)}
      {...rest}
    />
  );
}
