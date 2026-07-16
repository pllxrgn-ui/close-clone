import { useId, useMemo, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
} from '../../../../ui/index.ts';
import { ApiError } from '../../../../api/index.ts';
import { useToast } from '../../../../feedback/ToastProvider.tsx';
import { createCustomField, listCustomFields } from '../../api.ts';
import { CUSTOM_FIELDS_QUERY_KEY } from '../../queryKeys.ts';
import type { CustomFieldRow, CustomFieldType } from '../../types.ts';
import {
  TypeDateIcon,
  TypeNumberIcon,
  TypeSelectIcon,
  TypeTextIcon,
  TypeUserIcon,
  type IconProps,
} from '../../icons.tsx';

const TYPE_META: Record<CustomFieldType, { label: string; icon: (p: IconProps) => JSX.Element }> = {
  text: { label: 'Text', icon: TypeTextIcon },
  number: { label: 'Number', icon: TypeNumberIcon },
  date: { label: 'Date', icon: TypeDateIcon },
  select: { label: 'Select', icon: TypeSelectIcon },
  user: { label: 'User', icon: TypeUserIcon },
};

const ENTITY_ORDER = ['lead', 'contact', 'opportunity'] as const;
const ENTITY_LABEL: Record<(typeof ENTITY_ORDER)[number], string> = {
  lead: 'Lead fields',
  contact: 'Contact fields',
  opportunity: 'Opportunity fields',
};

function TypeChip({ type }: { type: CustomFieldType }): JSX.Element {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <span className="admin-chip admin-chip--type">
      <Icon size={12} />
      {meta.label}
    </span>
  );
}

export function CustomFieldsSection(): JSX.Element {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fieldsQuery = useQuery({
    queryKey: CUSTOM_FIELDS_QUERY_KEY,
    queryFn: () => listCustomFields(),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, CustomFieldRow[]>();
    for (const entity of ENTITY_ORDER) map.set(entity, []);
    for (const field of fieldsQuery.data ?? []) {
      map.get(field.entity)?.push(field);
    }
    return map;
  }, [fieldsQuery.data]);

  return (
    <section className="admin-section" aria-labelledby="admin-cf-title">
      <header className="admin-section__head">
        <h1 id="admin-cf-title" className="admin-section__title">
          Custom fields
        </h1>
        <p className="admin-section__desc">
          Structured fields on leads, contacts, and opportunities. Select and date fields become
          Smart View predicates automatically.
        </p>
      </header>

      {fieldsQuery.isLoading ? (
        <div className="admin-stack" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={36} />
          ))}
        </div>
      ) : fieldsQuery.isError ? (
        <ErrorState
          title="Couldn’t load custom fields"
          description={
            fieldsQuery.error instanceof ApiError ? fieldsQuery.error.message : undefined
          }
          onRetry={() => void fieldsQuery.refetch()}
        />
      ) : (
        <div className="admin-cf">
          {ENTITY_ORDER.map((entity) => {
            const rows = grouped.get(entity) ?? [];
            return (
              <div key={entity} className="admin-cf__group">
                <h2 className="admin-subhead">{ENTITY_LABEL[entity]}</h2>
                {rows.length === 0 ? (
                  <p className="admin-muted">No {entity} fields yet.</p>
                ) : (
                  <ul className="admin-cf__list">
                    {rows.map((field) => (
                      <li key={field.id} className="admin-cf__row">
                        <span className="admin-cf__label">{field.label}</span>
                        <code className="admin-cf__key">custom.{field.key}</code>
                        <TypeChip type={field.type} />
                        {field.required ? <span className="admin-chip">required</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          <CreateFieldForm
            onCreated={(field) => {
              toast(`Created ${field.entity} field “${field.label}”`);
              void queryClient.invalidateQueries({ queryKey: CUSTOM_FIELDS_QUERY_KEY });
            }}
          />
        </div>
      )}
    </section>
  );
}

function CreateFieldForm({
  onCreated,
}: {
  onCreated: (field: CustomFieldRow) => void;
}): JSX.Element {
  const baseId = useId();
  const [entity, setEntity] = useState<'lead' | 'contact' | 'opportunity'>('lead');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      createCustomField({
        entity,
        key: key.trim(),
        label: label.trim(),
        type,
        ...(type === 'select'
          ? {
              options: options
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean),
            }
          : {}),
        required,
      }),
    onSuccess: (field) => {
      onCreated(field);
      setKey('');
      setLabel('');
      setOptions('');
      setRequired(false);
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Could not create the field.');
    },
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  };

  return (
    <form className="admin-cf__form" onSubmit={onSubmit} aria-labelledby={`${baseId}-legend`}>
      <h2 id={`${baseId}-legend`} className="admin-subhead">
        New field
      </h2>
      <div className="admin-cf__form-grid">
        <Field label="Entity">
          <Select value={entity} onChange={(e) => setEntity(e.target.value as typeof entity)}>
            <option value="lead">Lead</option>
            <option value="contact">Contact</option>
            <option value="opportunity">Opportunity</option>
          </Select>
        </Field>
        <Field label="Label">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Account tier"
            required
          />
        </Field>
        <Field label="Key" error={error}>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="account_tier"
            pattern="[a-z][a-z0-9_]*"
            title="snake_case: lowercase letters, digits, underscores"
            className="admin-mono"
            required
          />
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
            {(Object.keys(TYPE_META) as CustomFieldType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_META[t].label}
              </option>
            ))}
          </Select>
        </Field>
        {type === 'select' ? (
          <Field label="Options (comma-separated)" className="admin-field--wide">
            <Input
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="Gold, Silver, Bronze"
            />
          </Field>
        ) : null}
        <Checkbox
          className="admin-cf__check"
          label="Required"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
      </div>
      <div className="admin-cf__form-actions">
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          Add field
        </Button>
      </div>
    </form>
  );
}
