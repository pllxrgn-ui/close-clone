/*
 * Smart View builder page (task W4). One AST is the source of truth: the visual
 * builder and the raw-DSL tab both read/write it (CONTRACTS §C3), and the live
 * preview + save consume it. Wired into the app router by the orchestrator at
 * merge — see the task report's routeWiring (exported, not self-registered,
 * because the router config is owned by another sprint task).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Ast } from '@switchboard/shared';
import { astToDsl, parse } from '@switchboard/shared';
import { listLeadStatuses, listUsers } from '../../api/reference.ts';
import { ApiError } from '../../api/errors.ts';
import { createSmartView, getSmartView, updateSmartView } from '../../api/smartViews.ts';
import { Button, Spinner } from '../../ui/index.ts';
import { useToast } from '../../feedback/index.ts';
import { fetchCustomFields, toDslCatalog } from './api.ts';
import { buildFieldOptions, type BuilderUser } from './catalog.ts';
import { BuilderPanel } from './BuilderPanel.tsx';
import { RawDslPanel } from './RawDslPanel.tsx';
import { PreviewPane } from './PreviewPane.tsx';
import { builderToAst, emptyRoot, rootFromAst, type GroupNode } from './model.ts';
import './builder.css';

type Tab = 'builder' | 'dsl';

export function ViewBuilderPage(): JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const viewId = params.id && params.id !== 'new' ? params.id : null;
  const editing = viewId !== null;

  const [root, setRoot] = useState<GroupNode>(() => emptyRoot());
  const [name, setName] = useState('Untitled view');
  const [shared, setShared] = useState(false);
  const [tab, setTab] = useState<Tab>('builder');
  const [ready, setReady] = useState(!editing);
  const initialized = useRef(false);

  // ── Reference data + catalog ────────────────────────────────────────────────
  const customFieldsQuery = useQuery({
    queryKey: ['admin-custom-fields'],
    queryFn: () => fetchCustomFields(),
    retry: false,
  });
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: () => listUsers() });
  const statusesQuery = useQuery({
    queryKey: ['lead-statuses'],
    queryFn: () => listLeadStatuses(),
  });
  const viewQuery = useQuery({
    queryKey: ['smart-view', viewId],
    queryFn: () => getSmartView(viewId as string),
    enabled: editing,
  });

  const catalogSettled = customFieldsQuery.isSuccess || customFieldsQuery.isError;
  const dslCatalog = useMemo(
    () => (customFieldsQuery.data ? toDslCatalog(customFieldsQuery.data) : []),
    [customFieldsQuery.data],
  );

  const statusLabels = useMemo(
    () => new Map((statusesQuery.data ?? []).map((s) => [s.id, s.label])),
    [statusesQuery.data],
  );
  const userNames = useMemo(
    () => new Map((usersQuery.data ?? []).map((u) => [u.id, u.name])),
    [usersQuery.data],
  );
  const builderUsers: BuilderUser[] = useMemo(
    () => (usersQuery.data ?? []).map((u) => ({ id: u.id, name: u.name })),
    [usersQuery.data],
  );

  const fieldOptions = useMemo(
    () =>
      buildFieldOptions(dslCatalog, {
        statuses: [...statusLabels.values()],
      }),
    [dslCatalog, statusLabels],
  );

  // ── Initialize the builder from a saved view (once, after data settles) ─────
  useEffect(() => {
    if (initialized.current || !editing) return;
    if (!viewQuery.data || !catalogSettled) return;
    const view = viewQuery.data;
    try {
      setRoot(rootFromAst(parse(view.dsl, { fieldCatalog: dslCatalog })));
    } catch {
      // Fall back to the stored AST if the DSL no longer parses under the catalog.
      setRoot(rootFromAst(view.ast as unknown as Ast));
    }
    setName(view.name);
    setShared(view.shared);
    initialized.current = true;
    setReady(true);
  }, [editing, viewQuery.data, catalogSettled, dslCatalog]);

  // ── Derived AST / DSL (single source of truth) ──────────────────────────────
  const ast = useMemo(() => builderToAst(root), [root]);
  const dsl = useMemo(() => (ast ? astToDsl(ast) : null), [ast]);

  // ── Save (create or update) ─────────────────────────────────────────────────
  const save = useMutation({
    mutationFn: async () => {
      if (dsl === null) throw new Error('Add at least one condition before saving.');
      if (editing) {
        return updateSmartView(viewId, { name, dsl, shared });
      }
      return createSmartView({ name, dsl, shared });
    },
    onSuccess: (view) => {
      void queryClient.invalidateQueries({ queryKey: ['smart-views'] });
      toast(editing ? 'Smart View saved' : 'Smart View created');
      if (!editing) navigate(`/views/${view.id}`);
    },
    onError: (err) => {
      const message =
        err instanceof ApiError
          ? `${err.message}`
          : err instanceof Error
            ? err.message
            : 'Save failed';
      toast(`Couldn’t save: ${message}`);
    },
  });

  const applyDsl = (nextAst: Ast): void => {
    setRoot(rootFromAst(nextAst));
    setTab('builder');
    toast('Applied DSL to the builder');
  };

  if (editing && !ready) {
    return (
      <div className="sb-page sb-vb-page">
        <div className="sb-vb-loading">
          <Spinner size="lg" label="Loading Smart View" />
        </div>
      </div>
    );
  }

  const canSave = dsl !== null && name.trim().length > 0 && !save.isPending;

  return (
    <div className="sb-page sb-vb-page">
      <header className="sb-vb-header">
        <div className="sb-vb-header__title">
          <label className="sb-vb-namelabel" htmlFor="sb-vb-name">
            View name
          </label>
          <input
            id="sb-vb-name"
            className="sb-input sb-vb-name"
            aria-label="View name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled view"
          />
        </div>
        <div className="sb-vb-header__actions">
          <label className="sb-vb-share">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            <span>Shared with team</span>
          </label>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!canSave}
            onClick={() => save.mutate()}
          >
            {editing ? 'Save changes' : 'Create view'}
          </Button>
        </div>
      </header>

      <div className="sb-vb-tabs" role="tablist" aria-label="Editor mode">
        <TabButton id="builder" active={tab === 'builder'} onSelect={setTab}>
          Builder
        </TabButton>
        <TabButton id="dsl" active={tab === 'dsl'} onSelect={setTab}>
          Raw DSL
        </TabButton>
      </div>

      <div className="sb-vb-layout">
        <div
          className="sb-vb-editor"
          role="tabpanel"
          id={`sb-vb-panel-${tab}`}
          aria-labelledby={`sb-vb-tab-${tab}`}
        >
          {tab === 'builder' ? (
            <BuilderPanel
              root={root}
              onRootChange={setRoot}
              fieldOptions={fieldOptions}
              users={builderUsers}
              catalogError={customFieldsQuery.isError}
            />
          ) : (
            <RawDslPanel initialDsl={dsl ?? ''} fieldCatalog={dslCatalog} onApply={applyDsl} />
          )}
        </div>

        <aside className="sb-vb-side">
          <PreviewPane ast={ast} statusLabels={statusLabels} userNames={userNames} />
        </aside>
      </div>
    </div>
  );
}

function TabButton({
  id,
  active,
  onSelect,
  children,
}: {
  id: Tab;
  active: boolean;
  onSelect: (t: Tab) => void;
  children: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      id={`sb-vb-tab-${id}`}
      aria-selected={active}
      aria-controls={`sb-vb-panel-${id}`}
      tabIndex={active ? 0 : -1}
      className={active ? 'sb-vb-tab is-active' : 'sb-vb-tab'}
      onClick={() => onSelect(id)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          onSelect(id === 'builder' ? 'dsl' : 'builder');
        }
      }}
    >
      {children}
    </button>
  );
}
