import { createContext, useContext } from 'react';

/*
 * Field wiring context. `Field` publishes the generated control id, the
 * describedby chain (hint/error ids) and validity; form controls (Input,
 * Textarea, Select, Checkbox) consume it via `useFieldControl` so that
 * `<Field><Input /></Field>` is fully wired with zero manual id plumbing.
 * Explicit props on the control always win over the context.
 */

export interface FieldContextValue {
  controlId: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

interface OwnControlProps {
  id?: string | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
}

interface ResolvedControlProps {
  id?: string | undefined;
  invalid?: boolean | undefined;
  describedBy?: string | undefined;
}

/** Merge a control's own props with the enclosing Field (own props win). */
export function useFieldControl(own: OwnControlProps): ResolvedControlProps {
  const field = useContext(FieldContext);
  if (!field) return own;
  return {
    id: own.id ?? field.controlId,
    invalid: own.invalid ?? (field.invalid || undefined),
    describedBy: own.describedBy ?? field.describedBy,
  };
}
