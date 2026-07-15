import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button.tsx';
import { IconButton } from './IconButton.tsx';
import { Input } from './Input.tsx';
import { Select } from './Select.tsx';
import { Kbd } from './Kbd.tsx';
import { StatusPill } from './StatusPill.tsx';
import { ListRow } from './ListRow.tsx';
import { EmptyState } from './EmptyState.tsx';
import { Spinner } from './Spinner.tsx';
import { Skeleton } from './Skeleton.tsx';
import { VisuallyHidden } from './VisuallyHidden.tsx';
import { SearchIcon } from './icons.tsx';

describe('Button', () => {
  test('renders and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  test('defaults to type=button (not a form submit)', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'button');
  });

  // failure path: disabled + loading must not invoke the handler
  test('disabled does not fire onClick', async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  test('loading marks aria-busy and disables the control', () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
  });
});

describe('IconButton', () => {
  test('exposes an accessible name from label', () => {
    render(
      <IconButton label="Search">
        <SearchIcon />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
  });
});

describe('Input', () => {
  test('accepts typing and forwards a ref', async () => {
    let captured: HTMLInputElement | null = null;
    render(
      <Input
        ref={(node) => {
          captured = node;
        }}
        aria-label="name"
      />,
    );
    const input = screen.getByLabelText('name');
    await userEvent.type(input, 'ada');
    expect(input).toHaveValue('ada');
    expect(captured).toBe(input);
  });

  test('invalid sets aria-invalid', () => {
    render(<Input aria-label="email" invalid />);
    expect(screen.getByLabelText('email')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Select', () => {
  test('renders options and selects a value', async () => {
    render(
      <Select aria-label="owner" defaultValue="a">
        <option value="a">Ada</option>
        <option value="b">Bo</option>
      </Select>,
    );
    const select = screen.getByLabelText('owner');
    await userEvent.selectOptions(select, 'b');
    expect(select).toHaveValue('b');
  });
});

describe('Kbd', () => {
  test('renders inside a kbd element', () => {
    render(<Kbd>/</Kbd>);
    const el = screen.getByText('/');
    expect(el.tagName).toBe('KBD');
  });
});

describe('StatusPill', () => {
  test('applies the tone class', () => {
    render(<StatusPill tone="overdue">Overdue</StatusPill>);
    expect(screen.getByText('Overdue')).toHaveClass('sb-pill', 'sb-pill--overdue');
  });

  test('neutral is the default tone', () => {
    render(<StatusPill>Draft?</StatusPill>);
    const el = screen.getByText('Draft?');
    expect(el).toHaveClass('sb-pill');
    expect(el.className).not.toMatch(/sb-pill--/);
  });
});

describe('ListRow', () => {
  test('interactive row is a keyboard-operable button', async () => {
    const onSelect = vi.fn();
    render(
      <ListRow onSelect={onSelect} ariaLabel="Acme Corp">
        Acme Corp
      </ListRow>,
    );
    const row = screen.getByRole('button', { name: 'Acme Corp' });
    await userEvent.tab();
    expect(row).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test('selected sets aria-current', () => {
    render(
      <ListRow onSelect={() => {}} ariaLabel="row" selected accent="var(--state-won-solid)">
        row
      </ListRow>,
    );
    expect(screen.getByRole('button', { name: 'row' })).toHaveAttribute('aria-current', 'true');
  });

  // failure path: without onSelect the row is not a button
  test('non-interactive row exposes no button role', () => {
    render(<ListRow>plain</ListRow>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('plain')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  test('renders title, description and actions', () => {
    render(
      <EmptyState
        title="No leads"
        description="Nothing here yet"
        actions={<Button>Add lead</Button>}
      />,
    );
    expect(screen.getByText('No leads')).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add lead' })).toBeInTheDocument();
  });
});

describe('Spinner', () => {
  test('exposes a status role with an accessible label', () => {
    render(<Spinner label="Loading leads" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading leads');
  });
});

describe('Skeleton', () => {
  test('is decorative (aria-hidden)', () => {
    const { container } = render(<Skeleton width={80} />);
    const el = container.querySelector('.sb-skeleton');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).toHaveStyle({ width: '80px' });
  });
});

describe('VisuallyHidden', () => {
  test('keeps content in the a11y tree but visually hidden', () => {
    render(<VisuallyHidden>hint</VisuallyHidden>);
    expect(screen.getByText('hint')).toHaveClass('sb-visually-hidden');
  });
});
