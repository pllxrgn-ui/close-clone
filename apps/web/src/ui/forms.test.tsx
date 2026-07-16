import { useState } from 'react';
import type { JSX } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field } from './Field.tsx';
import { Input } from './Input.tsx';
import { Select } from './Select.tsx';
import { Textarea } from './Textarea.tsx';
import { Checkbox } from './Checkbox.tsx';
import { Switch } from './Switch.tsx';
import { ErrorState } from './ErrorState.tsx';

describe('Field', () => {
  test('associates the label with the child control (zero manual ids)', () => {
    render(
      <Field label="Company">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Company')).toBeInTheDocument();
  });

  test('hint and error are wired via aria-describedby; error sets aria-invalid', () => {
    render(
      <Field label="Email" hint="Work address preferred" error="Not a valid email">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Work address preferred Not a valid email');
    expect(screen.getByRole('alert')).toHaveTextContent('Not a valid email');
  });

  // failure path: no error → no alert, control not invalid
  test('without error there is no alert and the control is valid', () => {
    render(
      <Field label="Email" hint="hint">
        <Input />
      </Field>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid');
  });

  test('explicit id on the control wins over the generated one', () => {
    render(
      <Field label="Owner" id="owner-field">
        <Input />
      </Field>,
    );
    expect(screen.getByLabelText('Owner')).toHaveAttribute('id', 'owner-field');
  });

  test('works with Select and Textarea children too', () => {
    render(
      <>
        <Field label="Status">
          <Select>
            <option value="a">A</option>
          </Select>
        </Field>
        <Field label="Notes" error="Required">
          <Textarea />
        </Field>
      </>,
    );
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Textarea', () => {
  test('accepts typing and forwards a ref', async () => {
    let captured: HTMLTextAreaElement | null = null;
    render(
      <Textarea
        ref={(node) => {
          captured = node;
        }}
        aria-label="notes"
      />,
    );
    const area = screen.getByLabelText('notes');
    await userEvent.type(area, 'call back tuesday');
    expect(area).toHaveValue('call back tuesday');
    expect(captured).toBe(area);
  });

  test('invalid sets aria-invalid', () => {
    render(<Textarea aria-label="notes" invalid />);
    expect(screen.getByLabelText('notes')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Checkbox', () => {
  test('toggles by clicking the inline label', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Include archived" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Include archived' });
    await userEvent.click(screen.getByText('Include archived'));
    expect(box).toBeChecked();
    expect(onChange).toHaveBeenCalledOnce();
  });

  test('indeterminate reflects on the input element', () => {
    render(<Checkbox label="All" indeterminate readOnly checked={false} onChange={() => {}} />);
    const box = screen.getByRole('checkbox', { name: 'All' });
    expect((box as HTMLInputElement).indeterminate).toBe(true);
  });

  // failure path: disabled must not toggle
  test('disabled does not toggle', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Locked" disabled onChange={onChange} />);
    await userEvent.click(screen.getByText('Locked'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  test('is keyboard-operable (Space)', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Notify" onChange={onChange} />);
    await userEvent.tab();
    expect(screen.getByRole('checkbox')).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledOnce();
  });
});

describe('Switch', () => {
  function Harness({ disabled = false }: { disabled?: boolean }): JSX.Element {
    const [on, setOn] = useState(false);
    return (
      <Switch
        label="Comfortable density"
        checked={on}
        onCheckedChange={setOn}
        disabled={disabled}
      />
    );
  }

  test('exposes role=switch with the label as accessible name', () => {
    render(<Harness />);
    expect(screen.getByRole('switch', { name: 'Comfortable density' })).toBeInTheDocument();
  });

  test('click flips aria-checked; label click works too', async () => {
    render(<Harness />);
    const control = screen.getByRole('switch');
    expect(control).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByText('Comfortable density'));
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  // failure path: disabled must not flip
  test('disabled does not flip', async () => {
    render(<Harness disabled />);
    await userEvent.click(screen.getByText('Comfortable density'));
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('ErrorState', () => {
  test('announces via role=alert and wires the retry action', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Couldn't load contacts" description="Timed out" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load contacts");
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  // failure path: no onRetry → no dangling Retry button
  test('renders no retry button without onRetry', () => {
    render(<ErrorState title="Failed" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
