import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Combobox, type ComboboxOption } from './Combobox.tsx';
import { Field } from './Field.tsx';

const REPS: ComboboxOption[] = [
  { value: 'ada', label: 'Ada Lovelace', sublabel: 'ada@switch.io' },
  { value: 'bo', label: 'Bo Diaz', sublabel: 'bo@switch.io' },
  { value: 'cy', label: 'Cy Chen', sublabel: 'cy@switch.io' },
  { value: 'di', label: 'Di Okafor', sublabel: 'di@switch.io', disabled: true },
];

/** Controlled harness so tests exercise the real onChange → value round-trip. */
function Harness({
  onChange,
  initial = null,
  ...rest
}: {
  onChange?: (v: string | null) => void;
  initial?: string | null;
} & Partial<React.ComponentProps<typeof Combobox>>) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Combobox
      label="Assign owner"
      options={REPS}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      placeholder="Search reps…"
      {...rest}
    />
  );
}

describe('Combobox — semantics', () => {
  test('renders a combobox input with an accessible name', () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Assign owner' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
  });

  test('shows the selected option label in the input', () => {
    render(<Harness initial="bo" />);
    expect(screen.getByRole('combobox')).toHaveValue('Bo Diaz');
  });
});

describe('Combobox — open + keyboard', () => {
  test('ArrowDown opens the listbox and marks aria-expanded', async () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    input.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Assign owner' })).toBeInTheDocument();
    // active option is tracked via aria-activedescendant, focus stays in the input
    expect(input).toHaveFocus();
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
  });

  test('ArrowDown/ArrowUp move the active option and Enter commits it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox');
    input.focus();
    await userEvent.keyboard('{ArrowDown}'); // open → active = Ada (index 0)
    await userEvent.keyboard('{ArrowDown}'); // active = Bo (index 1)
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('bo');
    expect(input).toHaveValue('Bo Diaz');
    expect(input).toHaveAttribute('aria-expanded', 'false'); // closes on commit
  });

  test('ArrowUp opens on the last enabled option', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    screen.getByRole('combobox').focus();

    await userEvent.keyboard('{ArrowUp}{Enter}');

    expect(onChange).toHaveBeenCalledWith('cy');
  });

  test('navigation skips a disabled option', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox');
    input.focus();
    // End jumps to the last enabled option (Di is disabled → lands on Cy)
    await userEvent.keyboard('{ArrowDown}{End}{Enter}');
    expect(onChange).toHaveBeenCalledWith('cy');
  });

  test('Escape closes and restores focus to the input without committing', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox');
    input.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Combobox — filtering', () => {
  test('typing filters the options (client mode)', async () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'bo');
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Bo Diaz')).toBeInTheDocument();
    expect(within(list).queryByText('Ada Lovelace')).not.toBeInTheDocument();
  });

  test('announces the filtered result count', async () => {
    render(<Harness />);

    await userEvent.type(screen.getByRole('combobox'), 'bo');

    expect(screen.getByRole('status')).toHaveTextContent('1 result available');
  });

  test('sublabel is searchable', async () => {
    render(<Harness />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'cy@');
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Cy Chen')).toBeInTheDocument();
    expect(within(list).queryByText('Ada Lovelace')).not.toBeInTheDocument();
  });

  test('no match shows the empty label', async () => {
    render(<Harness emptyLabel="No reps" />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'zzz');
    expect(screen.getByRole('listbox')).toHaveTextContent('No reps');
  });

  test('server mode forwards the query and does not filter locally', async () => {
    const onInputChange = vi.fn();
    render(<Harness onInputChange={onInputChange} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'zzz'); // matches nothing locally…
    expect(onInputChange).toHaveBeenLastCalledWith('zzz');
    // …but server mode keeps every provided option visible (parent owns filtering)
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Ada Lovelace')).toBeInTheDocument();
  });
});

describe('Combobox — mouse + clear', () => {
  test('clicking an option commits it', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: /Cy Chen/ }));
    expect(onChange).toHaveBeenCalledWith('cy');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('clicking a disabled option does not commit', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: /Di Okafor/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('clear button resets the selection', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} initial="ada" />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveValue('Ada Lovelace');
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(input).toHaveValue('');
  });

  test('no clear button when nothing is selected', () => {
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
  });
});

describe('Combobox — async + empty states', () => {
  test('loading announces a searching status', async () => {
    render(<Harness loading onInputChange={() => {}} />);
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toHaveTextContent(/searching/i);
  });

  test('disabled control does not open', async () => {
    render(<Harness disabled />);
    const input = screen.getByRole('combobox');
    expect(input).toBeDisabled();
    await userEvent.click(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('Combobox — defaultOpen + onClose (reveal-in-place)', () => {
  test('defaultOpen mounts the listbox open and focuses the input', () => {
    render(<Harness defaultOpen />);
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveFocus();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  test('Escape fires onClose but not onChange (a dismissal, not a pick)', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<Harness onChange={onChange} defaultOpen onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  test('committing a selection does NOT fire onClose', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(<Harness onChange={onChange} defaultOpen onClose={onClose} />);
    await userEvent.click(screen.getByRole('option', { name: /Ada Lovelace/ }));
    expect(onChange).toHaveBeenCalledWith('ada');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Combobox — Field integration', () => {
  test('takes its accessible name and invalid state from an enclosing Field', () => {
    render(
      <Field label="Owner" error="Required">
        <Combobox label="Owner" options={REPS} value={null} onChange={() => {}} />
      </Field>,
    );
    const input = screen.getByRole('combobox', { name: 'Owner' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    // the Field label drives the name — no duplicate aria-label on the control
    expect(input).not.toHaveAttribute('aria-label');
  });
});
