import type { IPty } from 'node-pty';
import type { Terminal as XTerm } from '@xterm/headless';
import xterm from '@xterm/headless';
import { loadPty } from './pty.js';

/** session: `claude attach`; agent: another coding agent; cloud: `claude --cloud`; command: a one-off tool like the diff pager. */
export type PaneKind = 'session' | 'agent' | 'cloud' | 'command';

export interface PaneOptions {
  id: string;
  kind: PaneKind;
  title: string;
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  onUpdate: () => void;
  onExit?: (code: number) => void;
}

/**
 * One child program (usually `claude attach <id>`) running in its own
 * pseudo-terminal, mirrored into a headless xterm so pitstop can draw it
 * anywhere on screen.
 */
export class Pane {
  readonly id: string;
  readonly kind: PaneKind;
  title: string;
  readonly term: XTerm;
  private pty: IPty | undefined;
  exited = false;
  exitCode: number | undefined;
  cursorVisible = true;
  bracketedPaste = false;
  /** Mouse tracking modes the child turned on (1000, 1002, 1003) and whether it wants SGR (1006) encoding. */
  mouseTracking = false;
  sgrMouse = false;
  /** Child is showing Claude Code's agent view instead of the session (the user pressed ← on an empty prompt). */
  inAgentView = false;
  private opts: PaneOptions;

  constructor(opts: PaneOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.kind = opts.kind;
    this.title = opts.title;
    this.term = new xterm.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      allowProposedApi: true,
      scrollback: 2000,
    });
    this.trackModes();
    this.spawn();
  }

  private trackModes(): void {
    const setMode = (params: (number | number[])[], on: boolean) => {
      for (const p of params.flat()) {
        if (p === 25) this.cursorVisible = on;
        if (p === 2004) this.bracketedPaste = on;
        if (p === 1000 || p === 1002 || p === 1003) this.mouseTracking = on;
        if (p === 1006) this.sgrMouse = on;
      }
      return false; // let xterm apply the mode too
    };
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => setMode(p, true));
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => setMode(p, false));
  }

  private spawn(): void {
    const pty = loadPty();
    this.exited = false;
    this.exitCode = undefined;
    this.inAgentView = false;
    this.pty = pty.spawn(this.opts.cmd, this.opts.args, {
      name: 'xterm-256color',
      cols: this.term.cols,
      rows: this.term.rows,
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    this.pty.onData((d) => {
      this.term.write(d, () => {
        if (this.kind === 'session') this.inAgentView = this.detectAgentView();
        this.opts.onUpdate();
      });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.opts.onExit?.(exitCode);
      this.opts.onUpdate();
    });
  }

  /** Restart the child (e.g. re-attach after the user left the session for agent view). */
  /** Change what the next respawn() runs (e.g. an agent's resume command). */
  setCommand(cmd: string, args: string[]): void {
    this.opts = { ...this.opts, cmd, args };
  }

  respawn(): void {
    this.kill();
    this.term.reset();
    this.spawn();
  }

  write(data: string): void {
    if (!this.exited) this.pty?.write(data);
  }

  /** Forward a paste, keeping or stripping bracketed-paste markers to match what the child asked for. */
  paste(data: string): void {
    this.write(this.bracketedPaste ? data : data.replace(/\x1b\[20[01]~/g, ''));
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, cols);
    rows = Math.max(1, rows);
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    if (!this.exited) {
      try {
        this.pty?.resize(cols, rows);
      } catch {
        // the child may be exiting
      }
    }
  }

  /** Visible text, one string per row. */
  lines(): string[] {
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let r = 0; r < this.term.rows; r++)
      out.push(buf.getLine(buf.viewportY + r)?.translateToString(true) ?? '');
    return out;
  }

  private detectAgentView(): boolean {
    return this.lines().some((l) => l.includes('describe a task for a new session'));
  }

  kill(): void {
    if (!this.exited) {
      try {
        this.pty?.kill();
      } catch {
        // already gone
      }
    }
  }

  dispose(): void {
    this.kill();
    this.term.dispose();
  }
}
