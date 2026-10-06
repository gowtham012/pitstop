import xterm from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { InputRouter, LineEditor } from '../../src/tui/input.js';
import { computeLayout, split } from '../../src/tui/layout.js';
import { diffScreens, Screen, textWidth, truncate } from '../../src/tui/screen.js';

const base = { visibleForks: 3, splitColumns: 160 };

describe('layout', () => {
  it('gives a lone main session the whole screen above the status bar', () => {
    const l = computeLayout({ ...base, cols: 200, rows: 50, ids: ['m'] });
    expect(l.panes).toHaveLength(1);
    expect(l.panes[0]!.rect).toEqual({ x: 0, y: 0, w: 200, h: 49 });
    expect(l.status).toEqual({ x: 0, y: 49, w: 200, h: 1 });
  });

  it('puts main on the left and stacks forks on the right on wide terminals', () => {
    const l = computeLayout({ ...base, cols: 201, rows: 41, ids: ['m', 'a', 'b'] });
    expect(l.orientation).toBe('side');
    const [m, a, b] = l.panes;
    expect(m!.rect).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(l.divider).toEqual({ x: 100, y: 0, w: 1, h: 40 });
    expect(a!.rect).toEqual({ x: 101, y: 0, w: 100, h: 20 });
    expect(b!.rect).toEqual({ x: 101, y: 20, w: 100, h: 20 });
    expect(a!.body).toEqual({ x: 101, y: 1, w: 100, h: 19 });
  });

  it('stacks main above the forks on narrow terminals', () => {
    const l = computeLayout({ ...base, cols: 100, rows: 41, ids: ['m', 'a'] });
    expect(l.orientation).toBe('stacked');
    expect(l.panes[0]!.rect).toEqual({ x: 0, y: 0, w: 100, h: 20 });
    expect(l.divider).toEqual({ x: 0, y: 20, w: 100, h: 1 });
    expect(l.panes[1]!.rect).toEqual({ x: 0, y: 21, w: 100, h: 19 });
  });

  it('turns forks past the visible limit into tabs, and swaps a focused hidden fork in', () => {
    const ids = ['m', 'a', 'b', 'c', 'd', 'e'];
    const l = computeLayout({ ...base, cols: 200, rows: 50, ids });
    expect(l.panes.map((p) => p.id)).toEqual(['m', 'a', 'b', 'c']);
    expect(l.hidden).toEqual(['d', 'e']);
    const f = computeLayout({ ...base, cols: 200, rows: 50, ids, focus: 'e' });
    expect(f.panes.map((p) => p.id)).toEqual(['m', 'a', 'b', 'e']);
    expect(f.hidden).toEqual(['c', 'd']);
  });

  it('shows fewer forks when the terminal is too short for them', () => {
    const l = computeLayout({ ...base, cols: 200, rows: 10, ids: ['m', 'a', 'b', 'c'] });
    expect(l.panes.length).toBeLessThan(4);
    for (const p of l.panes) expect(p.body.h).toBeGreaterThanOrEqual(2);
  });

  it('zooms one pane over everything', () => {
    const l = computeLayout({ ...base, cols: 200, rows: 50, ids: ['m', 'a', 'b'], zoom: 'a' });
    expect(l.panes.map((p) => p.id)).toEqual(['a']);
    expect(l.hidden).toEqual(['m', 'b']);
  });

  it('never leaves gaps or overlaps between stacked forks', () => {
    for (let rows = 12; rows < 60; rows++) {
      for (let n = 1; n <= 3; n++) {
        const ids = ['m', ...'abc'.slice(0, n)];
        const l = computeLayout({ ...base, cols: 200, rows, ids });
        const forks = l.panes.slice(1);
        expect(forks.reduce((s, p) => s + p.rect.h, 0)).toBe(rows - 1);
      }
    }
    expect(split(10, 3)).toEqual([4, 3, 3]);
  });
});

describe('input router', () => {
  const r = () => new InputRouter(0x1c);

  it('forwards ordinary keys and turns prefix + key into commands', () => {
    const router = r();
    expect(router.feed('abc')).toEqual([{ type: 'forward', data: 'abc' }]);
    expect(router.feed('x\x1cf')).toEqual([
      { type: 'forward', data: 'x' },
      { type: 'prefix' },
      { type: 'command', command: 'fork' },
    ]);
  });

  it('handles the prefix and its key arriving separately', () => {
    const router = r();
    expect(router.feed('\x1c')).toEqual([{ type: 'prefix' }]);
    expect(router.waitingForCommand).toBe(true);
    expect(router.feed('m')).toEqual([{ type: 'command', command: 'merge' }]);
  });

  it('sends the prefix through when pressed twice', () => {
    expect(r().feed('\x1c\x1c')).toEqual([{ type: 'prefix' }, { type: 'forward', data: '\x1c' }]);
  });

  it('reads arrows and digits after the prefix', () => {
    expect(r().feed('\x1c\x1b[C')).toContainEqual({ type: 'command', command: 'next' });
    expect(r().feed('\x1c3')).toContainEqual({ type: 'command', command: 'jump:3' });
  });

  it('cancels on escape or an unknown key', () => {
    expect(r().feed('\x1c\x1b')).toContainEqual({ type: 'cancel' });
    expect(r().feed('\x1cQ')).toContainEqual({ type: 'cancel' });
  });

  it('ignores the prefix byte inside a bracketed paste', () => {
    const router = r();
    const paste = '\x1b[200~has \x1c inside\x1b[201~';
    expect(router.feed(paste)).toEqual([{ type: 'forward', data: paste }]);
    expect(router.feed('\x1b[200~split')).toEqual([{ type: 'forward', data: '\x1b[200~split' }]);
    expect(router.feed(' \x1c paste\x1b[201~after')).toEqual([
      { type: 'forward', data: ' \x1c paste\x1b[201~after' },
    ]);
  });

  it('decodes SGR mouse events', () => {
    expect(r().feed('\x1b[<0;10;5M')).toEqual([
      { type: 'mouse', button: 0, x: 9, y: 4, release: false },
    ]);
  });
});

describe('line editor', () => {
  it('edits and submits', () => {
    const e = new LineEditor();
    expect(e.feed('fix the bug')).toBeUndefined();
    e.feed('\x7f\x7f\x7f');
    e.feed('crash');
    expect(e.value).toBe('fix the crash');
    e.feed('\x17');
    expect(e.value).toBe('fix the');
    expect(e.feed('\r')).toBe('submit');
  });

  it('cancels on escape and ignores arrow keys and paste markers', () => {
    const e = new LineEditor();
    e.feed('\x1b[200~pasted\x1b[201~\x1b[D');
    expect(e.value).toBe('pasted');
    expect(e.feed('\x1b')).toBe('cancel');
  });
});

describe('screen', () => {
  it('measures and truncates wide text', () => {
    expect(textWidth('ab')).toBe(2);
    expect(textWidth('日本')).toBe(4);
    expect(truncate('hello world', 6)).toBe('hello…');
    expect(truncate('hi', 6)).toBe('hi');
  });

  it('only rewrites changed cells', () => {
    const a = new Screen(10, 2);
    a.text(0, 0, 'hello', '0');
    const full = diffScreens(undefined, a);
    expect(full).toContain('\x1b[2J');
    const b = new Screen(10, 2);
    b.text(0, 0, 'hellO', '0');
    const delta = diffScreens(a, b);
    expect(delta).toContain('\x1b[1;5H');
    expect(delta).toContain('O');
    expect(delta).not.toContain('hell');
    expect(diffScreens(b, b)).toBe('');
  });

  it('copies a headless terminal into a region with its colors', async () => {
    const term = new xterm.Terminal({ cols: 6, rows: 2, allowProposedApi: true });
    await new Promise<void>((r) => term.write('\x1b[31mred\x1b[0m ok', r));
    const s = new Screen(10, 3);
    s.blit(term, { x: 2, y: 1, w: 6, h: 2 });
    expect(s.get(2, 1).ch).toBe('r');
    expect(s.get(2, 1).sgr).toBe('0;31');
    expect(s.get(6, 1).ch).toBe('o');
    expect(s.get(6, 1).sgr).toBe('0');
  });
});
