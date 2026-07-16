import { useKeyBindings } from '../../../keyboard/index.ts';
import type { KeyBindingDef } from '../../../keyboard/index.ts';

/*
 * The board's full keyboard alternative to drag. Registered in the `route` scope
 * and gated on board focus, so the keys are live only while a card is focused
 * (and they show up in the ? cheat sheet automatically). Left/right and the
 * bracket keys move the focused deal a stage at a time; W/L close it won/lost;
 * up/down walk cards within a column; Enter opens the lead.
 */

interface UsePipelineKeyboardParams {
  /** Whether focus is currently inside the board (guards every binding). */
  focusWithin: boolean;
  onMoveStage: (dir: -1 | 1) => void;
  onTerminal: (kind: 'won' | 'lost') => void;
  onNavCard: (dir: -1 | 1) => void;
  onOpen: () => void;
}

const GROUP = 'Pipeline';

export function usePipelineKeyboard(params: UsePipelineKeyboardParams): void {
  const { focusWithin, onMoveStage, onTerminal, onNavCard, onOpen } = params;
  const when = (): boolean => focusWithin;

  const defs: KeyBindingDef[] = [
    {
      id: 'pl-next-bracket',
      combo: ']',
      scope: 'route',
      label: 'Move deal to next stage',
      group: GROUP,
      when,
      handler: () => onMoveStage(1),
    },
    {
      id: 'pl-next-arrow',
      combo: 'arrowright',
      scope: 'route',
      label: 'Move deal to next stage',
      group: GROUP,
      hidden: true,
      when,
      handler: () => onMoveStage(1),
    },
    {
      id: 'pl-prev-bracket',
      combo: '[',
      scope: 'route',
      label: 'Move deal to previous stage',
      group: GROUP,
      when,
      handler: () => onMoveStage(-1),
    },
    {
      id: 'pl-prev-arrow',
      combo: 'arrowleft',
      scope: 'route',
      label: 'Move deal to previous stage',
      group: GROUP,
      hidden: true,
      when,
      handler: () => onMoveStage(-1),
    },
    {
      id: 'pl-won',
      combo: 'w',
      scope: 'route',
      label: 'Mark deal won',
      group: GROUP,
      when,
      handler: () => onTerminal('won'),
    },
    {
      id: 'pl-lost',
      combo: 'l',
      scope: 'route',
      label: 'Mark deal lost',
      group: GROUP,
      when,
      handler: () => onTerminal('lost'),
    },
    {
      id: 'pl-card-down',
      combo: 'arrowdown',
      scope: 'route',
      label: 'Next card in column',
      group: GROUP,
      when,
      handler: () => onNavCard(1),
    },
    {
      id: 'pl-card-up',
      combo: 'arrowup',
      scope: 'route',
      label: 'Previous card in column',
      group: GROUP,
      when,
      handler: () => onNavCard(-1),
    },
    {
      id: 'pl-open',
      combo: 'enter',
      scope: 'route',
      label: 'Open lead',
      group: GROUP,
      when,
      handler: () => onOpen(),
    },
  ];

  useKeyBindings(defs);
}
