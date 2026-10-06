import type { IBufferCell, Terminal as XTerm } from '@xterm/headless';
import type { Rect } from './layout.js';

export interface Cell {
  ch: string;
  /** 1 normally, 2 for wide characters, 0 for the cell a wide character spills into. */
  w: number;
  sgr: string;
}

const BLANK: Cell = { ch: ' ', w: 1, sgr: '0' };

/** Styles used for pitstop's own chrome. */
export const STYLE = {
  plain: '0',
  dim: '0;2',
  bold: '0;1',
  // pane frames: the focused pane gets the accent, the rest stay quiet
  frame: '0;38;5;240',
  frameFocus: '0;1;38;5;215',
  title: '0;38;5;250',
  titleMain: '0;1;38;5;110',
  titleFocus: '0;1;38;5;231',
  meta: '0;38;5;244',
  notice: '0;1;38;5;178',
  stateWorking: '0;38;5;114',
  stateNeeds: '0;1;38;5;178',
  stateIdle: '0;38;5;245',
  stateStopped: '0;38;5;167',
  stateDone: '0;1;38;5;114',
  // bottom bar
  status: '0;38;5;250;48;5;235',
  statusDim: '0;38;5;244;48;5;235',
  statusFocus: '0;1;38;5;16;48;5;215',
  statusMain: '0;38;5;110;48;5;235',
  statusFork: '0;38;5;250;48;5;235',
  warn: '0;1;38;5;16;48;5;178',
  ok: '0;38;5;114;48;5;235',
  error: '0;1;38;5;231;48;5;160',
  overlay: '0;38;5;252;48;5;237',
  overlayBorder: '0;38;5;215;48;5;237',
  overlayTitle: '0;1;38;5;215;48;5;237',
  prompt: '0;1;38;5;16;48;5;215',
};

/** Rough display width: wide for CJK and most emoji, 0 for combining marks. */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Remove escape sequences and control characters from text pitstop draws
 * itself (file names, test output, error messages), so they can't move the
 * cursor or change the terminal's state when written out.
 */
export function stripControls(s: string): string {
  return s
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Cut `s` to at most `max` columns, adding an ellipsis when it was longer. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (textWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function colorParams(
  isRgb: boolean,
  isPalette: boolean,
  color: number,
  base: number,
  bright: number,
): string {
  if (isRgb) return `;${base + 8};2;${(color >> 16) & 255};${(color >> 8) & 255};${color & 255}`;
  if (isPalette) {
    if (color < 8) return `;${base + color}`;
    if (color < 16) return `;${bright + color - 8}`;
    return `;${base + 8};5;${color}`;
  }
  return '';
}

export function cellSgr(c: IBufferCell): string {
  let s = '0';
  if (c.isBold()) s += ';1';
  if (c.isDim()) s += ';2';
  if (c.isItalic()) s += ';3';
  if (c.isUnderline()) s += ';4';
  if (c.isBlink()) s += ';5';
  if (c.isInverse()) s += ';7';
  if (c.isInvisible()) s += ';8';
  if (c.isStrikethrough()) s += ';9';
  s += colorParams(!!c.isFgRGB(), !!c.isFgPalette(), c.getFgColor(), 30, 90);
  s += colorParams(!!c.isBgRGB(), !!c.isBgPalette(), c.getBgColor(), 40, 100);
  return s;
}

/**
 * A full-terminal grid of cells. pitstop composes each frame into one of
 * these and writes only the cells that differ from the previous frame.
 */
export class Screen {
  cells: Cell[];

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: cols * rows }, () => BLANK);
  }

  set(x: number, y: number, cell: Cell): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    this.cells[y * this.cols + x] = cell;
  }

  get(x: number, y: number): Cell {
    return this.cells[y * this.cols + x] ?? BLANK;
  }

  fill(r: Rect, ch = ' ', sgr = '0'): void {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, { ch, w: 1, sgr });
  }

  /** Write text clipped to `maxW` columns. Returns the column after the last character. */
  text(x: number, y: number, s: string, sgr: string, maxW = this.cols - x): number {
    const end = x + maxW;
    for (const ch of stripControls(s)) {
      const w = charWidth(ch);
      if (w === 0) continue;
      if (x + w > end) break;
      this.set(x, y, { ch, w, sgr });
      if (w === 2) this.set(x + 1, y, { ch: '', w: 0, sgr });
      x += w;
    }
    return x;
  }

  /** Copy the visible part of a headless terminal into `r`. */
  blit(term: XTerm, r: Rect): void {
    const buf = term.buffer.active;
    const cell = buf.getNullCell();
    for (let row = 0; row < r.h; row++) {
      const line = buf.getLine(buf.viewportY + row);
      for (let col = 0; col < r.w; col++) {
        const c = line?.getCell(col, cell);
        if (!c) {
          this.set(r.x + col, r.y + row, BLANK);
          continue;
        }
        const w = c.getWidth();
        const chars = c.getChars();
        if (w === 2 && col === r.w - 1) {
          this.set(r.x + col, r.y + row, { ch: ' ', w: 1, sgr: cellSgr(c) }); // wide char cut by the pane edge
          continue;
        }
        this.set(r.x + col, r.y + row, { ch: w === 0 ? '' : chars || ' ', w, sgr: cellSgr(c) });
      }
    }
  }
}

/** Escape sequences that turn `prev` into `next` (or draw `next` fully when there is no `prev`). */
export function diffScreens(prev: Screen | undefined, next: Screen): string {
  const full = !prev || prev.cols !== next.cols || prev.rows !== next.rows;
  let out = full ? '\x1b[0m\x1b[2J' : '';
  let sgr = '';
  for (let y = 0; y < next.rows; y++) {
    let x = 0;
    let cursorAt = -1;
    while (x < next.cols) {
      const c = next.get(x, y);
      const changed =
        full ||
        !sameCell(prev!.get(x, y), c) ||
        (c.w === 2 && !sameCell(prev!.get(x + 1, y), next.get(x + 1, y)));
      if (!changed || c.w === 0) {
        x++;
        continue;
      }
      if (cursorAt !== x) out += `\x1b[${y + 1};${x + 1}H`;
      if (c.sgr !== sgr) {
        out += `\x1b[${c.sgr}m`;
        sgr = c.sgr;
      }
      out += c.ch || ' ';
      x += Math.max(1, c.w);
      cursorAt = x;
    }
  }
  return out ? out + '\x1b[0m' : '';
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.ch === b.ch && a.w === b.w && a.sgr === b.sgr;
}
