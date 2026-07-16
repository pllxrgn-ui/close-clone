import { useId, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Snippet, Template } from '@switchboard/shared';
import { Button, ErrorState, Field, Input, Skeleton, Textarea } from '../../../../ui/index.ts';
import { Modal } from '../../../../ui/Modal.tsx';
import { ApiError } from '../../../../api/index.ts';
import { useToast } from '../../../../feedback/ToastProvider.tsx';
import { listSnippets, listTemplates, updateSnippet, updateTemplate } from '../../api.ts';
import { SNIPPETS_QUERY_KEY, TEMPLATES_QUERY_KEY } from '../../queryKeys.ts';
import { PencilIcon } from '../../icons.tsx';

/*
 * Templates & snippets — read-backed lists; editing opens a right-anchored drawer
 * (the shared Modal primitive, so focus-trap / Escape / focus-restore come free).
 * Saving writes to the store and toasts; the list reflects it on close.
 */

type Editing = { kind: 'template'; item: Template } | { kind: 'snippet'; item: Snippet } | null;

function preview(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > 88 ? `${line.slice(0, 88)}…` : line;
}

export function TemplatesSection(): JSX.Element {
  const templatesQuery = useQuery({
    queryKey: TEMPLATES_QUERY_KEY,
    queryFn: () => listTemplates(),
  });
  const snippetsQuery = useQuery({ queryKey: SNIPPETS_QUERY_KEY, queryFn: () => listSnippets() });
  const [editing, setEditing] = useState<Editing>(null);

  const loading = templatesQuery.isLoading || snippetsQuery.isLoading;
  const errored = templatesQuery.isError || snippetsQuery.isError;
  const loadError = templatesQuery.error ?? snippetsQuery.error;

  return (
    <section className="admin-section" aria-labelledby="admin-tpl-title">
      <header className="admin-section__head">
        <h1 id="admin-tpl-title" className="admin-section__title">
          Templates &amp; snippets
        </h1>
        <p className="admin-section__desc">
          Reusable email bodies and quick text snippets. Merge tags like{' '}
          <code className="admin-mono">{'{{contact.firstName}}'}</code> resolve at send time.
        </p>
      </header>

      {loading ? (
        <div className="admin-stack" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={36} />
          ))}
        </div>
      ) : errored ? (
        <ErrorState
          title="Couldn’t load templates"
          description={loadError instanceof ApiError ? loadError.message : undefined}
          onRetry={() => {
            void templatesQuery.refetch();
            void snippetsQuery.refetch();
          }}
        />
      ) : (
        <>
          <div className="admin-cf__group">
            <h2 className="admin-subhead">Templates</h2>
            <ul className="admin-tpl__list">
              {(templatesQuery.data ?? []).map((tpl) => (
                <li key={tpl.id} className="admin-tpl__row">
                  <span className="admin-tpl__name">{tpl.name}</span>
                  <span className="admin-chip">{tpl.channel}</span>
                  <span className="admin-tpl__preview admin-mono">
                    {tpl.subject ? `${tpl.subject} — ` : ''}
                    {preview(tpl.body)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="admin-tpl__edit"
                    onClick={() => setEditing({ kind: 'template', item: tpl })}
                  >
                    <PencilIcon size={13} />
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          </div>

          <div className="admin-cf__group">
            <h2 className="admin-subhead">Snippets</h2>
            <ul className="admin-tpl__list">
              {(snippetsQuery.data ?? []).map((snp) => (
                <li key={snp.id} className="admin-tpl__row">
                  <code className="admin-tpl__shortcut admin-mono">{snp.shortcut}</code>
                  <span className="admin-tpl__preview admin-mono">{preview(snp.body)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="admin-tpl__edit"
                    onClick={() => setEditing({ kind: 'snippet', item: snp })}
                  >
                    <PencilIcon size={13} />
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <EditorDrawer editing={editing} onClose={() => setEditing(null)} />
    </section>
  );
}

function EditorDrawer({
  editing,
  onClose,
}: {
  editing: Editing;
  onClose: () => void;
}): JSX.Element | null {
  if (!editing) return null;
  return <EditorDrawerBody editing={editing} onClose={onClose} key={editing.item.id} />;
}

function EditorDrawerBody({
  editing,
  onClose,
}: {
  editing: NonNullable<Editing>;
  onClose: () => void;
}): JSX.Element {
  const headingId = useId();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isTemplate = editing.kind === 'template';

  const [name, setName] = useState(isTemplate ? editing.item.name : '');
  const [subject, setSubject] = useState(isTemplate ? (editing.item.subject ?? '') : '');
  const [shortcut, setShortcut] = useState(isTemplate ? '' : editing.item.shortcut);
  const [body, setBody] = useState(editing.item.body);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      if (editing.kind === 'template') {
        return updateTemplate(editing.item.id, {
          name: name.trim(),
          subject: subject.trim() ? subject.trim() : null,
          body,
        });
      }
      return updateSnippet(editing.item.id, { shortcut: shortcut.trim(), body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: isTemplate ? TEMPLATES_QUERY_KEY : SNIPPETS_QUERY_KEY,
      });
      toast(isTemplate ? `Saved “${name.trim()}”` : `Saved ${shortcut.trim()}`);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={headingId}
      className="admin-drawer"
      backdropClassName="admin-drawer__backdrop"
    >
      <form className="admin-drawer__form" onSubmit={onSubmit}>
        <header className="admin-drawer__head">
          <h2 id={headingId} className="admin-drawer__title">
            {isTemplate ? 'Edit template' : 'Edit snippet'}
          </h2>
        </header>
        <div className="admin-drawer__body">
          {isTemplate ? (
            <>
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="Subject">
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="(no subject)"
                />
              </Field>
            </>
          ) : (
            <Field label="Shortcut">
              <Input
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                className="admin-mono"
                required
              />
            </Field>
          )}
          <Field label="Body" className="admin-field--grow" error={error}>
            <Textarea
              className="admin-mono"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={isTemplate ? 12 : 5}
              required
            />
          </Field>
        </div>
        <footer className="admin-drawer__actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Save
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
