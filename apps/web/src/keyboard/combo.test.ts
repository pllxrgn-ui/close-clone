import { describe, expect, test } from 'vitest';
import {
  comboToCapSteps,
  eventToCombo,
  isSequence,
  isTypingTarget,
  readableCombo,
  sequencePrefix,
} from './combo.ts';

function ev(partial: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe('eventToCombo', () => {
  test('collapses Ctrl and Cmd to a platform-agnostic mod', () => {
    expect(eventToCombo(ev({ key: 'k', ctrlKey: true }))).toBe('mod+k');
    expect(eventToCombo(ev({ key: 'k', metaKey: true }))).toBe('mod+k');
  });

  test('lowercases letters so Shift+K and k match the same binding', () => {
    expect(eventToCombo(ev({ key: 'K', shiftKey: true }))).toBe('k');
    expect(eventToCombo(ev({ key: 'k' }))).toBe('k');
  });

  test('keeps the shifted glyph for printable keys (no redundant shift)', () => {
    // "?" is Shift+/ but the browser already reports key="?".
    expect(eventToCombo(ev({ key: '?', shiftKey: true }))).toBe('?');
    expect(eventToCombo(ev({ key: '/' }))).toBe('/');
  });

  test('records shift only for named (non-printable) keys', () => {
    expect(eventToCombo(ev({ key: 'Enter', shiftKey: true }))).toBe('shift+enter');
    expect(eventToCombo(ev({ key: 'Escape' }))).toBe('escape');
    expect(eventToCombo(ev({ key: 'ArrowDown' }))).toBe('arrowdown');
  });

  test('orders modifiers mod, alt, then key', () => {
    expect(eventToCombo(ev({ key: 'k', ctrlKey: true, altKey: true }))).toBe('mod+alt+k');
  });

  test('normalizes the space key to a named token', () => {
    expect(eventToCombo(ev({ key: ' ' }))).toBe('space');
  });
});

describe('isTypingTarget', () => {
  test('true for input, textarea, select, and contenteditable', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom reports isContentEditable via the attribute
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  test('false for buttons, divs, and null', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('sequences', () => {
  test('detects sequences and extracts the prefix', () => {
    expect(isSequence('g i')).toBe(true);
    expect(isSequence('mod+k')).toBe(false);
    expect(sequencePrefix('g i')).toBe('g');
    expect(sequencePrefix('mod+k')).toBe('mod+k');
  });
});

describe('presentation', () => {
  test('comboToCapSteps splits chords and sequences into cap groups', () => {
    expect(comboToCapSteps('mod+k')).toEqual([['Ctrl', 'K']]);
    expect(comboToCapSteps('g i')).toEqual([['G'], ['I']]);
    expect(comboToCapSteps('?')).toEqual([['?']]);
    expect(comboToCapSteps('arrowdown')).toEqual([['↓']]);
  });

  test('readableCombo renders a screen-reader label', () => {
    expect(readableCombo('mod+k')).toBe('Control K');
    expect(readableCombo('g i')).toBe('G then I');
    expect(readableCombo('escape')).toBe('Escape');
  });
});
