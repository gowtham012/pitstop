export type Command =
  | 'fork'
  | 'bg-fork'
  | 'merge'
  | 'diff'
  | 'pull'
  | 'tree'
  | 'discard'
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
  x: 'discard',
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
 * Splits raw terminal input into what goes to the focused pane and what is
 * a pitstop command. The prefix byte is ignored inside bracketed pastes, and
 * pressing the prefix twice sends it through literally.
 */
export class InputRouter {
  private armed = false;
  private inPaste = false;

  constructor(private readonly prefix: number) {}

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
