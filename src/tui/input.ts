export type Command =
  | 'fork'
  | 'bg-fork'
  | 'merge'
  | 'diff'
  | 'pull'
  | 'tree'
  | 'delete'
  | 'zoom'
  | 'reattach'
  | 'help'
  | 'quit'
  | 'report'
  | 'send'
  | 'next'
  | 'prev'
  | 'up'
  | 'down'
  | `jump:${number}`;

export type InputAction =
  | { type: 'forward'; data: string }
  | { type: 'command'; command: Command }
  | { type: 'mouse'; button: number; x: number; y: number; release: boolean }
  | { type: 'prefix' }
  | { type: 'cancel' };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const KEYS: Record<string, Command> = {
  f: 'fork',
  b: 'bg-fork',
  m: 'merge',
  d: 'diff',
  p: 'pull',
  t: 'tree',
  x: 'delete',
  z: 'zoom',
  r: 'reattach',
  e: 'report',
  s: 'send',
  '?': 'help',
  q: 'quit',
  '\x1b[C': 'next',
  '\x1b[D': 'prev',
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  o: 'next',
};

/**
 * One-step shortcuts, no prefix: function keys (both the xterm and the
 * rxvt/Linux-console spellings of F1-F4), and the symbols macOS terminals
 * type for Option+letter by default (⌥F types ƒ). Only symbols nobody types
 * into a prompt are used; letters such as ß or œ are left alone.
 */
export const SHORT_KEYS: [string, Command][] = [
  ['\x1bOP', 'help'],
  ['\x1b[11~', 'help'],
  ['\x1bOQ', 'fork'],
  ['\x1b[12~', 'fork'],
  ['\x1bOR', 'merge'],
  ['\x1b[13~', 'merge'],
  ['\x1bOS', 'diff'],
  ['\x1b[14~', 'diff'],
  ['\x1b[15~', 'tree'],
  ['\x1b[17~', 'pull'],
  ['\x1b[18~', 'report'],
  ['\x1b[19~', 'delete'],
  ['\x1b[20~', 'zoom'],
  ['\x1b[21~', 'quit'], // F10
  ['ƒ', 'fork'], // ⌥F
  ['∫', 'bg-fork'], // ⌥B
  ['µ', 'merge'], // ⌥M
  ['∂', 'diff'], // ⌥D
  ['π', 'pull'], // ⌥P
  ['†', 'tree'], // ⌥T
  ['≈', 'delete'], // ⌥X
  ['Ω', 'zoom'], // ⌥Z
  ['®', 'report'], // ⌥R
  ['÷', 'help'], // ⌥/
];

/**
 * Splits raw terminal input into what goes to the focused pane and what is
 * a pitstop command. The prefix byte is ignored inside bracketed pastes, and
 * pressing the prefix twice sends it through literally.
 */
export class InputRouter {
  private armed = false;
  private inPaste = false;

  constructor(
    private readonly prefix: number,
    private readonly shortKeys = true,
  ) {}

  get waitingForCommand(): boolean {
    return this.armed;
  }

  feed(data: string): InputAction[] {
    const out: InputAction[] = [];
    let forward = '';
    const flush = () => {
      if (forward) out.push({ type: 'forward', data: forward });
      forward = '';
    };
    let i = 0;
    while (i < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          forward += data.slice(i);
          break;
        }
        forward += data.slice(i, end + PASTE_END.length);
        i = end + PASTE_END.length;
        this.inPaste = false;
        continue;
      }
      if (data.startsWith(PASTE_START, i)) {
        this.inPaste = true;
        forward += PASTE_START;
        i += PASTE_START.length;
        continue;
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
      if (mouse) {
        flush();
        out.push({
          type: 'mouse',
          button: Number(mouse[1]),
          x: Number(mouse[2]) - 1,
          y: Number(mouse[3]) - 1,
          release: mouse[4] === 'm',
        });
        i += mouse[0].length;
        continue;
      }
      const short = this.shortKeys
        ? SHORT_KEYS.find(([seq]) => data.startsWith(seq, i))
        : undefined;
      if (short) {
        flush();
        this.armed = false;
        out.push({ type: 'command', command: short[1] });
        i += short[0].length;
        continue;
      }
      if (this.armed) {
        this.armed = false;
        const seq = /^\x1b\[[A-D]/.exec(data.slice(i))?.[0] ?? data[i]!;
        i += seq.length;
        if (seq.charCodeAt(0) === this.prefix && seq.length === 1) {
          forward += seq; // prefix twice: send it through
        } else if (seq === '\x1b' || seq === '\x03') {
          flush();
          out.push({ type: 'cancel' });
        } else if (/^[1-9]$/.test(seq)) {
          flush();
          out.push({ type: 'command', command: `jump:${Number(seq)}` });
        } else if (KEYS[seq]) {
          flush();
          out.push({ type: 'command', command: KEYS[seq]! });
        } else {
          flush();
          out.push({ type: 'cancel' });
        }
        continue;
      }
      if (data.charCodeAt(i) === this.prefix) {
        flush();
        this.armed = true;
        out.push({ type: 'prefix' });
        i++;
        continue;
      }
      forward += data[i];
      i++;
    }
    flush();
    return out;
  }
}

/** Minimal line editor used by the fork prompt in the status bar. */
export class LineEditor {
  value = '';

  /** Returns 'submit' or 'cancel' when the line is finished, 'tab' when Tab was pressed. */
  feed(data: string): 'submit' | 'cancel' | 'tab' | undefined {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') return 'submit';
      if (ch === '\x1b') {
        if (data.startsWith(PASTE_START, i)) {
          i += PASTE_START.length - 1;
          continue;
        }
        if (data.startsWith(PASTE_END, i)) {
          i += PASTE_END.length - 1;
          continue;
        }
        if (data[i + 1] === '[') {
          i += 2; // skip arrow keys and other CSI input
          while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++;
          continue;
        }
        return 'cancel';
      }
      if (code === 3) return 'cancel';
      if (ch === '\t') return 'tab';
      if (code === 127 || code === 8) {
        this.value = [...this.value].slice(0, -1).join('');
        continue;
      }
      if (code === 21) {
        this.value = '';
        continue;
      }
      if (code === 23) {
        this.value = this.value.replace(/\s*\S+\s*$/, '');
        continue;
      }
      if (code >= 32) this.value += ch;
    }
    return undefined;
  }
}

/**
 * Length of the first keypress in a chunk of terminal input: a CSI or SS3
 * escape sequence (arrows, mouse), a lone ESC, or one character.
 */
export function firstKeyLength(data: string): number {
  if (data[0] !== '\x1b' || data.length === 1) return Math.max(1, [...data][0]?.length ?? 1);
  if (data[1] === '[') {
    for (let i = 2; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
    }
    return data.length;
  }
  if (data[1] === 'O') return Math.min(3, data.length);
  return 1;
}
