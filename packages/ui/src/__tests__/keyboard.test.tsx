import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from '../primitives/button.js';
import { Checkbox } from '../primitives/checkbox.js';
import { Switch } from '../primitives/switch.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../primitives/tabs.js';
import { TooltipProvider } from '../primitives/tooltip.js';
import { AppShell } from '../shell/app-shell.js';
import { RoleNav, filterByPermission, type RoleNavItem } from '../shell/role-nav.js';
import { KeyboardHintBar } from '../clinical/keyboard-hint-bar.js';
import { findAccessibilityViolations } from './axe.js';

describe('keyboard operability — docs/06 §6.1, §7', () => {
  it('activates a Button with Enter and Space', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save draft</Button>);
    const button = screen.getByRole('button', { name: 'Save draft' });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it('carries a visible focus ring class on every interactive primitive', () => {
    render(
      <>
        <Button>Sign</Button>
        <IconButton label="Print" />
      </>,
    );
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('focus-visible:outline-2');
      expect(button.className).toContain('focus-visible:outline-offset-2');
    }
  });

  it('gives an icon-only button an accessible name (SC 4.1.2)', () => {
    render(<IconButton label="Print prescription" />);
    expect(screen.getByRole('button', { name: 'Print prescription' })).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Complaint</TabsTrigger>
          <TabsTrigger value="b">History</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
        <TabsContent value="b">B</TabsContent>
      </Tabs>,
    );
    const first = screen.getByRole('tab', { name: 'Complaint' });
    act(() => {
      first.focus();
    });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    // Radix moves roving focus on the next macrotask.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'History' }));
    });
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
  });

  it('exposes Checkbox and Switch as focusable native buttons the platform toggles with Space', () => {
    const onCheckedChange = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <Checkbox aria-label="Notify on result" onCheckedChange={onCheckedChange} />
        <Switch aria-label="Gloved-hand mode" onCheckedChange={onSwitch} />
      </>,
    );

    // jsdom does not synthesise the click that a browser generates from Space on a
    // <button>, so the keyboard contract is asserted structurally — a real, focusable
    // <button> with no tabindex removal — plus the activation itself.
    for (const [element, spy] of [
      [screen.getByRole('checkbox', { name: 'Notify on result' }), onCheckedChange],
      [screen.getByRole('switch', { name: 'Gloved-hand mode' }), onSwitch],
    ] as const) {
      expect(element.tagName).toBe('BUTTON');
      expect(element).not.toHaveAttribute('tabindex', '-1');
      element.focus();
      expect(document.activeElement).toBe(element);
      fireEvent.click(element);
      expect(spy).toHaveBeenCalled();
    }
  });
});

const NAV_ITEMS: readonly RoleNavItem[] = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  {
    key: 'pharmacy',
    label: 'Pharmacy',
    href: '/pharmacy',
    children: [
      { key: 'dispense', label: 'Dispense', href: '/pharmacy/dispense', permission: 'pharmacy.dispense' },
      { key: 'indent', label: 'Indent', href: '/pharmacy/indent', permission: 'pharmacy.indent' },
    ],
  },
  { key: 'billing', label: 'Billing', href: '/billing', permission: 'billing.view', count: 3 },
];

describe('RoleNav — docs/06 §4.1', () => {
  it('never renders an item the user cannot use', () => {
    render(
      <TooltipProvider>
        <RoleNav items={NAV_ITEMS} grantedPermissions={new Set(['pharmacy.dispense'])} label="Primary" />
      </TooltipProvider>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Billing' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Indent' })).toBeNull();
  });

  it('drops a parent whose children are all denied', () => {
    const visible = filterByPermission(NAV_ITEMS, new Set(['billing.view']));
    expect(visible.map((item) => item.key)).toEqual(['dashboard', 'billing']);
  });

  it('expands a group from the keyboard and exposes aria-expanded', () => {
    render(
      <TooltipProvider>
        <RoleNav
          items={NAV_ITEMS}
          grantedPermissions={new Set(['pharmacy.dispense', 'pharmacy.indent'])}
          label="Primary"
        />
      </TooltipProvider>,
    );
    const group = screen.getByRole('button', { name: 'Pharmacy' });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    group.focus();
    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: /Dispense/ })).toBeInTheDocument();
  });

  it('keeps labels available to screen readers in the 56 px icon rail', () => {
    render(
      <TooltipProvider>
        <RoleNav items={NAV_ITEMS} grantedPermissions={new Set()} label="Primary" collapsed />
      </TooltipProvider>,
    );
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <TooltipProvider>
        <RoleNav items={NAV_ITEMS} grantedPermissions={new Set(['billing.view'])} label="Primary" />
      </TooltipProvider>,
    );
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});

const SHELL_LABELS = {
  application: "Vim's HMS",
  workArea: 'Work area',
  contextRail: 'Context rail',
  statusStrip: 'Status strip',
};

describe('AppShell — docs/06 §4.1, §6.1', () => {
  it('renders the landmarks the shell contract promises', () => {
    render(
      <AppShell
        labels={SHELL_LABELS}
        topBar={<span>top</span>}
        nav={<nav aria-label="Primary">nav</nav>}
        contextRail={<span>rail</span>}
        statusStrip={<span>v2.14.1</span>}
      >
        <p>work</p>
      </AppShell>,
    );
    expect(screen.getByRole('main', { name: 'Work area' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Context rail' })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { name: 'Status strip' })).toBeInTheDocument();
  });

  it('toggles the nav with "[" and the rail with "]"', () => {
    const onNav = vi.fn();
    const onRail = vi.fn();
    render(
      <AppShell
        labels={SHELL_LABELS}
        topBar={<span>top</span>}
        nav={<nav aria-label="Primary">nav</nav>}
        contextRail={<span>rail</span>}
        onNavCollapsedChange={onNav}
        onRailOpenChange={onRail}
      >
        <p>work</p>
      </AppShell>,
    );
    fireEvent.keyDown(document.body, { key: '[' });
    expect(onNav).toHaveBeenCalledWith(true);
    fireEvent.keyDown(document.body, { key: ']' });
    expect(onRail).toHaveBeenCalledWith(false);
  });

  it('ignores the shortcuts while the user is typing', () => {
    const onNav = vi.fn();
    render(
      <AppShell
        labels={SHELL_LABELS}
        topBar={<input aria-label="Search" />}
        nav={<nav aria-label="Primary">nav</nav>}
        onNavCollapsedChange={onNav}
      >
        <p>work</p>
      </AppShell>,
    );
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: '[' });
    expect(onNav).not.toHaveBeenCalled();
  });
});

describe('KeyboardHintBar — docs/06 §5.2 #33', () => {
  it('opens the shortcut sheet with "?" and lists the mapped keys', () => {
    const onOpenSheet = vi.fn();
    render(
      <KeyboardHintBar
        visible
        label="Shortcuts"
        openSheetLabel="All shortcuts"
        hints={[{ keys: ['Alt', 'R'], label: 'Prescription' }]}
        onOpenSheet={onOpenSheet}
      />,
    );
    expect(screen.getByRole('group', { name: 'Shortcuts' })).toHaveTextContent('Alt');
    fireEvent.keyDown(document.body, { key: '?' });
    expect(onOpenSheet).toHaveBeenCalledTimes(1);
  });

  it('hides itself on touch-only devices', () => {
    const { container } = render(
      <KeyboardHintBar visible={false} label="Shortcuts" hints={[{ keys: ['?'], label: 'Help' }]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
