import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Opportunity, OpportunityStage } from '@switchboard/shared';
import { ApiError } from '../../../api/index.ts';
import { listUsers } from '../../../api/reference.ts';
import { Button, EmptyState, Skeleton } from '../../../ui/index.ts';
import { cx } from '../../../lib/cx.ts';
import {
  fetchAllOpportunities,
  fetchLeadNames,
  listOpportunityStages,
  moveOpportunity,
} from '../api/opportunities.ts';
import { buildBoard } from '../model/board.ts';
import { adjacentStage, statusForStage, terminalKind, terminalStage } from '../lib/stages.ts';
import type { TerminalKind } from '../lib/stages.ts';
import { registerMover, setActiveOpp } from '../state/boardInteraction.ts';
import type { MoveDir } from '../state/boardInteraction.ts';
import { KanbanIcon } from '../icons.tsx';
import { BoardHeader } from './BoardHeader.tsx';
import { PipelineColumn } from './PipelineColumn.tsx';
import { OpportunityCard } from './OpportunityCard.tsx';
import { useCardDrag } from './useCardDrag.ts';
import { usePipelineKeyboard } from './usePipelineKeyboard.ts';

const OPPS_KEY = ['pipeline', 'opportunities'] as const;
const STAGES_KEY = ['pipeline', 'stages'] as const;
const LEAD_NAMES_KEY = ['pipeline', 'lead-names'] as const;
const USERS_KEY = ['pipeline', 'users'] as const;

const FLASH_MS = 600;
const EMPTY_OPPS: Opportunity[] = [];
const EMPTY_STAGES: OpportunityStage[] = [];

/*
 * Real datasets put thousands of deals on the board; rendering them all is what
 * made real mode sluggish. Money math stays FULL-DATA (buildBoard sees every
 * deal, so counts/sums are exact) — only the DOM is bounded: each column shows
 * its top CAP cards (largest-first, the ones that matter) plus a Show-all
 * expander. The active card is always rendered even past the cap, so a
 * keyboard move into a crowded column never drops focus.
 */
export const COLUMN_RENDER_CAP = 30;

interface MoveVars {
  id: string;
  stageId: string;
  status: Opportunity['status'];
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return 'Something went wrong.';
}

export function PipelineBoard(): JSX.Element {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const now = useMemo(() => new Date(), []);

  const oppsQuery = useQuery({
    queryKey: OPPS_KEY,
    queryFn: ({ signal }) => fetchAllOpportunities(signal),
  });
  const stagesQuery = useQuery({
    queryKey: STAGES_KEY,
    queryFn: ({ signal }) => listOpportunityStages(signal),
  });
  // Lead names label the cards. Resolving them drains every page of GET /leads
  // (~25 serial round-trips at 5k leads — the board's biggest network cost). It
  // is the same id→name map for the whole session, so cache it hard: fetch once,
  // then serve from cache on every remount/refocus instead of re-draining. (The
  // ideal — resolving names for only the ~30 rendered cards/column — needs a
  // batch `GET /leads?ids=` the contract doesn't offer yet; see the report.)
  const leadNamesQuery = useQuery({
    queryKey: LEAD_NAMES_KEY,
    queryFn: ({ signal }) => fetchLeadNames(signal),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const usersQuery = useQuery({ queryKey: USERS_KEY, queryFn: () => listUsers() });

  const opps = oppsQuery.data ?? EMPTY_OPPS;
  const stages = stagesQuery.data ?? EMPTY_STAGES;

  const board = useMemo(() => buildBoard(opps, stages), [opps, stages]);
  const oppsById = useMemo(() => new Map(opps.map((o) => [o.id, o])), [opps]);
  const stagesById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
  const orderedCards = useMemo(() => board.columns.flatMap((c) => c.cards), [board]);

  // ── Bounded rendering (see COLUMN_RENDER_CAP) ──────────────────────────────
  const [expandedCols, setExpandedCols] = useState<ReadonlySet<string>>(() => new Set());
  const expandColumn = useCallback((stageId: string): void => {
    setExpandedCols((prev) => new Set(prev).add(stageId));
  }, []);

  const leadNameOf = useCallback(
    (leadId: string): string => leadNamesQuery.data?.get(leadId) ?? 'Unknown lead',
    [leadNamesQuery.data],
  );
  const ownerNameOf = useCallback(
    (ownerId: string | null): string | null => {
      if (!ownerId) return null;
      return usersQuery.data?.find((u) => u.id === ownerId)?.name ?? null;
    },
    [usersQuery.data],
  );

  // ── Focus / active card (roving tabindex) ──────────────────────────────────
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusWithin, setFocusWithin] = useState(false);
  const effectiveActiveId =
    activeId && oppsById.has(activeId) ? activeId : (orderedCards[0]?.id ?? null);

  // Cards actually rendered per column: top CAP by value, the active card
  // pinned in even when it sorts past the cap, everything when expanded.
  const visibleByStage = useMemo(() => {
    const map = new Map<string, Opportunity[]>();
    for (const col of board.columns) {
      if (expandedCols.has(col.stage.id) || col.cards.length <= COLUMN_RENDER_CAP) {
        map.set(col.stage.id, col.cards);
        continue;
      }
      const top = col.cards.slice(0, COLUMN_RENDER_CAP);
      if (effectiveActiveId && !top.some((c) => c.id === effectiveActiveId)) {
        const active = col.cards.find((c) => c.id === effectiveActiveId);
        if (active) top.push(active);
      }
      map.set(col.stage.id, top);
    }
    return map;
  }, [board, expandedCols, effectiveActiveId]);

  const cardRefs = useRef(new Map<string, HTMLLIElement>());
  const refSetters = useRef(new Map<string, (el: HTMLLIElement | null) => void>());
  const getRefSetter = useCallback((id: string) => {
    let fn = refSetters.current.get(id);
    if (!fn) {
      fn = (el: HTMLLIElement | null): void => {
        if (el) cardRefs.current.set(id, el);
        else cardRefs.current.delete(id);
      };
      refSetters.current.set(id, fn);
    }
    return fn;
  }, []);

  // Move focus to the active card after a keyboard action (never on load/drag).
  const keyboardNavRef = useRef(false);
  const oppsSignature = useMemo(() => opps.map((o) => `${o.id}:${o.stageId}`).join('|'), [opps]);
  useLayoutEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    if (effectiveActiveId) cardRefs.current.get(effectiveActiveId)?.focus();
  }, [effectiveActiveId, oppsSignature]);

  // ── Move mutation (optimistic so keyboard actions are instant / 0ms) ───────
  const [flash, setFlash] = useState<{ id: string; kind: TerminalKind } | null>(null);
  const [announce, setAnnounce] = useState('');
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const moveMutation = useMutation({
    mutationFn: (vars: MoveVars) =>
      moveOpportunity(vars.id, { stageId: vars.stageId, status: vars.status }),
    onMutate: async (vars: MoveVars) => {
      await qc.cancelQueries({ queryKey: OPPS_KEY });
      const prev = qc.getQueryData<Opportunity[]>(OPPS_KEY);
      qc.setQueryData<Opportunity[]>(OPPS_KEY, (old) =>
        old
          ? old.map((o) =>
              o.id === vars.id ? { ...o, stageId: vars.stageId, status: vars.status } : o,
            )
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(OPPS_KEY, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: OPPS_KEY });
    },
  });

  const doMove = useCallback(
    (id: string, targetStageId: string, viaKeyboard: boolean): void => {
      const current = oppsById.get(id);
      const stage = stagesById.get(targetStageId);
      if (!current || !stage || current.stageId === targetStageId) return;

      const kind = terminalKind(stage);
      setActiveId(id);
      if (viaKeyboard) keyboardNavRef.current = true;
      if (kind) {
        setFlash({ id, kind });
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
      }
      setAnnounce(`${leadNameOf(current.leadId)} moved to ${stage.label}`);
      moveMutation.mutate({ id, stageId: targetStageId, status: statusForStage(stage) });
    },
    [oppsById, stagesById, leadNameOf, moveMutation],
  );

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const moveStage = useCallback(
    (id: string, dir: -1 | 1): void => {
      const current = oppsById.get(id);
      if (!current) return;
      const target = adjacentStage(stages, current.stageId, dir);
      if (target) doMove(id, target.id, true);
    },
    [oppsById, stages, doMove],
  );
  const moveTerminal = useCallback(
    (id: string, kind: TerminalKind): void => {
      const target = terminalStage(stages, kind);
      if (target) doMove(id, target.id, true);
    },
    [stages, doMove],
  );
  const navCard = useCallback(
    (dir: -1 | 1): void => {
      const id = effectiveActiveId;
      if (!id) return;
      for (const col of board.columns) {
        // Navigate over the RENDERED cards only — J/K must never land on a
        // card the bounded column isn't showing.
        const cards = visibleByStage.get(col.stage.id) ?? col.cards;
        const idx = cards.findIndex((c) => c.id === id);
        if (idx >= 0) {
          const next = cards[idx + dir];
          if (next) {
            keyboardNavRef.current = true;
            setActiveId(next.id);
          }
          return;
        }
      }
    },
    [effectiveActiveId, board, visibleByStage],
  );
  const openActive = useCallback((): void => {
    const id = effectiveActiveId;
    if (!id) return;
    const opp = oppsById.get(id);
    if (opp) navigate(`/leads/${opp.leadId}`);
  }, [effectiveActiveId, oppsById, navigate]);

  // ── Pointer drag ───────────────────────────────────────────────────────────
  const stageOf = useCallback((id: string) => oppsById.get(id)?.stageId ?? null, [oppsById]);
  const { drag, onCardPointerDown } = useCardDrag({
    stageOf,
    onDrop: (id, stageId) => doMove(id, stageId, false),
  });

  // ── Keyboard bindings (bracket/arrow/W/L, cheat-sheet visible) ─────────────
  usePipelineKeyboard({
    focusWithin,
    onMoveStage: (dir) => {
      if (effectiveActiveId) moveStage(effectiveActiveId, dir);
    },
    onTerminal: (kind) => {
      if (effectiveActiveId) moveTerminal(effectiveActiveId, kind);
    },
    onNavCard: navCard,
    onOpen: openActive,
  });

  // ── Command-palette bridge ─────────────────────────────────────────────────
  const moverImplRef = useRef<(dir: MoveDir) => void>(() => undefined);
  useEffect(() => {
    moverImplRef.current = (dir: MoveDir): void => {
      const id = effectiveActiveId;
      if (!id) return;
      if (dir === 'next') moveStage(id, 1);
      else if (dir === 'prev') moveStage(id, -1);
      else moveTerminal(id, dir);
    };
  });
  useEffect(() => {
    const unregister = registerMover((dir) => moverImplRef.current(dir));
    return () => {
      unregister();
      setActiveOpp(null);
    };
  }, []);
  useEffect(() => {
    const opp = effectiveActiveId ? oppsById.get(effectiveActiveId) : undefined;
    setActiveOpp(opp ? { id: opp.id, label: leadNameOf(opp.leadId) } : null);
  }, [effectiveActiveId, oppsById, leadNameOf]);

  const onBoardFocus = (): void => setFocusWithin(true);
  const onBoardBlur = (event: FocusEvent): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const blockingError = stagesQuery.error ?? oppsQuery.error;
  const busy = stagesQuery.isLoading || oppsQuery.isLoading;

  let body: JSX.Element;
  if (blockingError) {
    body = (
      <EmptyState
        title="Couldn’t load the pipeline"
        description={errorMessage(blockingError)}
        icon={<KanbanIcon size={28} />}
        actions={
          <Button
            onClick={() => {
              void oppsQuery.refetch();
              void stagesQuery.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (busy && opps.length === 0) {
    body = <BoardSkeleton />;
  } else if (stages.length === 0) {
    body = (
      <EmptyState
        title="No pipeline stages"
        description="Add opportunity stages to start tracking deals."
        icon={<KanbanIcon size={28} />}
      />
    );
  } else {
    body = (
      <div
        className="pl-board"
        role="group"
        aria-label="Pipeline by stage"
        onFocus={onBoardFocus}
        onBlur={onBoardBlur}
      >
        {board.columns.map((col) => {
          const visible = visibleByStage.get(col.stage.id) ?? col.cards;
          const hiddenCount = col.count - visible.length;
          return (
            <PipelineColumn
              key={col.stage.id}
              column={col}
              isDropTarget={drag?.dropStageId === col.stage.id && drag?.id !== undefined}
              cardCount={col.count}
              footer={
                hiddenCount > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="pl-col__more"
                    aria-label={`Show all ${col.count} deals in ${col.stage.label}`}
                    onClick={() => expandColumn(col.stage.id)}
                  >
                    Show all {col.count}
                  </Button>
                ) : null
              }
            >
              {visible.map((opp) => (
                <OpportunityCard
                  key={opp.id}
                  opp={opp}
                  leadName={leadNameOf(opp.leadId)}
                  ownerName={ownerNameOf(opp.ownerId)}
                  stageLabel={col.stage.label}
                  now={now}
                  active={opp.id === effectiveActiveId}
                  dragging={drag?.id === opp.id}
                  flash={flash?.id === opp.id ? flash.kind : null}
                  registerRef={getRefSetter(opp.id)}
                  onFocus={() => setActiveId(opp.id)}
                  onPointerDown={(event) => onCardPointerDown(event, opp.id)}
                  {...(drag?.id === opp.id
                    ? { style: { transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0)` } }
                    : {})}
                />
              ))}
            </PipelineColumn>
          );
        })}
      </div>
    );
  }

  return (
    <div className={cx('pl-surface')}>
      <BoardHeader
        totals={board.totals}
        weightedTotals={board.weightedTotals}
        dealCount={orderedCards.length}
      />
      {body}
      <div className="pl-sr-status" role="status" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}

function BoardSkeleton(): JSX.Element {
  return (
    <div className="pl-board" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="pl-col pl-col--skeleton">
          <Skeleton height={20} className="pl-col__skeleton-head" />
          {Array.from({ length: 3 }, (_, j) => (
            <Skeleton key={j} height={78} className="pl-col__skeleton-card" />
          ))}
        </div>
      ))}
    </div>
  );
}
