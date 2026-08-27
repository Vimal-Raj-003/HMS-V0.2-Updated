import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Shortcut } from '@/features/frontoffice/lib/shortcuts';
import { isNonTextKey, isTextEntry, useCounterShortcuts } from './counter-shortcuts';

/**
 * The keyboard rule the dispensing counter needs, and the bug it fixes.
 *
 * The shared `useShortcuts` refuses every key while focus is in a field. On this
 * screen the scan field holds focus for the whole transaction, so that guard
 * would make `F8` and `F10` dead while the `KeyboardHintBar` advertised them.
 */
describe('which keys survive a focused field', () => {
  it('knows a function key is not text', () => {
    for (const key of ['F1', 'F3', 'F4', 'F7', 'F8', 'F9', 'F10', 'F12', 'Escape']) {
      expect(isNonTextKey(key), key).toBe(true);
    }
  });

  it('knows a letter is text and must not be stolen from a barcode', () => {
    for (const key of ['a', 'Z', '4', 'Enter', 'Tab', ' ', 'F13']) {
      expect(isNonTextKey(key), key).toBe(false);
    }
  });

  it('recognises the fields a scan or a reason is typed into', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const div = document.createElement('div');
    expect(isTextEntry(input)).toBe(true);
    expect(isTextEntry(textarea)).toBe(true);
    expect(isTextEntry(select)).toBe(true);
    expect(isTextEntry(div)).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it('treats a contenteditable as text entry too', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    // jsdom does not implement `isContentEditable` from the attribute.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTextEntry(div)).toBe(true);
  });
});

/**
 * A sanity check on the shape the hook consumes, so a `Shortcut` whose `enabled`
 * is false is never bound. It is asserted on the data rather than through the
 * DOM because the hook's own effect is exercised by the counter screen.
 */
describe('the shortcut list', () => {
  it('drops a shortcut whose action the session cannot perform', () => {
    const run = vi.fn();
    const shortcuts: readonly Shortcut[] = [
      { key: 'F10', label: 'Complete', keys: ['F10'], run, enabled: false },
    ];
    expect(shortcuts.filter((shortcut) => shortcut.enabled !== false)).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * The hook itself, driven through the DOM, because the property that matters is
 * a property of the listener rather than of the predicate: **F10 fires while the
 * scan field has focus**. The shared `useShortcuts` would not, which is why this
 * hook exists.
 */
function Harness({ shortcuts }: { readonly shortcuts: readonly Shortcut[] }): React.JSX.Element {
  useCounterShortcuts(shortcuts);
  return <input data-testid="scan" />;
}

describe('useCounterShortcuts', () => {
  function bind(): { readonly complete: ReturnType<typeof vi.fn>; readonly hold: ReturnType<typeof vi.fn> } {
    const complete = vi.fn();
    const hold = vi.fn();
    render(
      <Harness
        shortcuts={[
          { key: 'F10', label: 'Complete', keys: ['F10'], run: complete },
          { key: 'h', label: 'Hold', keys: ['H'], run: hold },
        ]}
      />,
    );
    return { complete, hold };
  }

  it('fires a function key while the scan field has focus — the whole point', () => {
    const { complete } = bind();
    const scan = screen.getByTestId('scan');
    scan.focus();
    fireEvent.keyDown(scan, { key: 'F10' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('still refuses a letter while the scan field has focus', () => {
    const { hold } = bind();
    const scan = screen.getByTestId('scan');
    scan.focus();
    fireEvent.keyDown(scan, { key: 'h' });
    expect(hold).not.toHaveBeenCalled();
  });

  it('fires a letter when nothing is being typed into', () => {
    const { hold } = bind();
    fireEvent.keyDown(document.body, { key: 'h' });
    expect(hold).toHaveBeenCalledTimes(1);
  });

  /**
   * A confirmation dialog exists to make somebody stop and read. A background
   * hotkey acting underneath it defeats the friction — and on this screen the
   * dialog underneath which F10 must not fire is the second pharmacist's
   * sign-in.
   */
  it('fires nothing at all while a dialog is open', () => {
    const { complete, hold } = bind();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(document.body, { key: 'F10' });
      fireEvent.keyDown(document.body, { key: 'h' });
      expect(complete).not.toHaveBeenCalled();
      expect(hold).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it('never binds a shortcut the session cannot use', () => {
    const run = vi.fn();
    render(<Harness shortcuts={[{ key: 'F9', label: 'Co-sign', keys: ['F9'], run, enabled: false }]} />);
    fireEvent.keyDown(document.body, { key: 'F9' });
    expect(run).not.toHaveBeenCalled();
  });
});
