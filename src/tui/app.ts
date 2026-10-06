import fs from 'node:fs';
import path from 'node:path';
import {
  branchKind,
  listBranches,
  loadBranch,
  LIVE_STATES,
  updateBranch,
  type BranchRecord,
} from '../branches.js';
import {
  claudeBin,
  findAgent,
  listAgentsAsync,
  stopSession,
  type AgentInfo,
} from '../claude/agents.js';
import { loadConfig, parseTaskInput, prefixByte, type PitConfig } from '../core/config.js';
import { runSync } from '../core/exec.js';
import { repoContext, type RepoContext } from '../core/git.js';
import { repoStateDir } from '../core/paths.js';
import { readJson, writeJsonAtomic } from '../core/store.js';
import { cloudForkReady, messageCloudFork, parseCloudSession, remoteHead } from '../fork/cloud.js';
import { recordAgentConsent } from '../fork/common.js';
import { ConfirmationNeeded, forkSession } from '../fork/fork.js';
import { adoptMainSession, ensureMainSession, type MainSession } from '../fork/main.js';
import { sendInbox } from '../inbox.js';
import {
  clearHistory,
  deleteFork,
  finishedForks,
  mergeBranch,
  pullFromParent,
} from '../merge/merge.js';
import { collectTouched, findOverlaps, overlapKey, type Overlap } from '../radar.js';
import { buildReport, writeReport } from '../report.js';
import { sessionCost, sessionState, stateGlyph, treeLines, type CostInfo } from '../status.js';
import { startBackgroundUpgrade, takeNotice } from '../upgrade.js';
import { firstKeyLength, InputRouter, LineEditor, type Command } from './input.js';
import { computeLayout, type Layout, type PaneSlot } from './layout.js';
import { Pane } from './pane.js';
import { tuiPidFile } from './presence.js';
import { diffScreens, Screen, STYLE, textWidth, truncate } from './screen.js';

export interface AppOptions {
  cwd: string;
  claudeArgs?: string[];
  prompt?: string;
  /** Adopt this existing session as main instead of starting one. */
  mainSessionId?: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

type Overlay =
  | { kind: 'text'; title: string; lines: string[]; keys?: OverlayKey[] }
  | {
      kind: 'confirm';
      title: string;
      lines: string[];
      onYes: () => void;
      alt?: OverlayKey;
      /** More keys that mean yes, e.g. F10 again in the quit popup. */
      yesKeys?: string[];
    }
  | {
      kind: 'pick';
      title: string;
      items: { label: string; value: string }[];
      onPick: (value: string) => void;
    };

/** An extra one-letter choice in an overlay, e.g. `c` for "delete its conversation too". */
interface OverlayKey {
  key: string;
  label: string;
  run: () => void;
}

interface Prompt {
  label: string;
  editor: LineEditor;
  onSubmit: (value: string) => void;
  onTab?: () => void;
}

interface SavedLayout {
  order: string[];
  focus?: string;
  zoom?: string;
}

const HELP = [
  'Click a button in the bottom bar, or press a key:',
  '',
  '            one key   Mac      or ctrl+\\ then',
  '  fork         F2      ⌥F         f',
  '  bg fork              ⌥B         b',
  '  merge        F3      ⌥M         m',
  '  diff         F4      ⌥D         d',
  '  tree         F5      ⌥T         t',
  '  pull main    F6      ⌥P         p',
  '  report       F7      ⌥R         e',
  '  delete       F8      ⌥X         x',
  '  zoom         F9      ⌥Z         z',
  '  help         F1      ⌥/         ?',
  '  quit         F10                q   (F10 twice; sessions keep running)',
  '',
  'Switch panes: click a pane or a tab, or ctrl+\\ ← → / 1-9.',
  'In the fork prompt, Tab cycles presets: hotfix, explore, cloud, codex, gemini, …',
  'On a MacBook, press fn with the F key unless F-keys are standard keys.',
];

/** Bottom-bar buttons. */
const BUTTONS: { label: string; key: string; command: Command; style?: string }[] = [
  { label: '+ Fork', key: 'F2', command: 'fork' },
  { label: 'Merge', key: 'F3', command: 'merge' },
  { label: 'Diff', key: 'F4', command: 'diff' },
  { label: 'Tree', key: 'F5', command: 'tree' },
  { label: 'Delete', key: 'F8', command: 'delete' },
  { label: '?', key: 'F1', command: 'help' },
  { label: 'Quit', key: 'F10', command: 'quit', style: STYLE.buttonQuit },
];

function stateStyle(state: string): string {
  switch (state) {
    case 'working':
    case 'running':
    case 'starting':
      return STYLE.stateWorking;
    case 'needs input':
      return STYLE.stateNeeds;
    case 'ready':
    case 'merged':
      return STYLE.stateDone;
    case 'stopped':
    case 'failed':
      return STYLE.stateStopped;
    default:
      return STYLE.stateIdle;
  }
}

/** pitstop's split-pane terminal UI. */
export class App {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private ctx!: RepoContext;
  private cfg!: PitConfig & { untrusted?: string[] };
  private router!: InputRouter;
  private main!: MainSession;
  private panes = new Map<string, Pane>();
  /** Session ids (main first) and command-pane ids, in display order. */
  private order: string[] = [];
  private focus = '';
  private zoom: string | undefined;
  private overlay: Overlay | undefined;
  /** The main session's pane, fixed at startup. */
  private mainPaneId = '';
  private prompt: Prompt | undefined;
  private agents = new Map<string, AgentInfo>();
  private branches: BranchRecord[] = [];
  private overlaps: Overlap[] = [];
  private notified = new Set<string>();
  private costs = new Map<string, CostInfo>();
  private message: { text: string; style: string; until: number } | undefined;
  private busyLabel: string | undefined;
  private prev: Screen | undefined;
  private lastLayout: Layout | undefined;
  private renderTimer: NodeJS.Timeout | undefined;
  private timers: NodeJS.Timeout[] = [];
  private lastCloudCheck = 0;
  private stopped = false;
  private exitResolve: (() => void) | undefined;

  constructor(private readonly opts: AppOptions) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
  }

  private get cols(): number {
    return this.stdout.columns || 120;
  }

  private get rows(): number {
    return this.stdout.rows || 40;
  }

  /** Start the UI. Resolves when the user quits. */
  async run(): Promise<void> {
    this.ctx = repoContext(this.opts.cwd);
    this.cfg = loadConfig(this.ctx.top);
    this.router = new InputRouter(prefixByte(this.cfg.prefixKey), this.cfg.shortKeys);
    this.stdout.write('pitstop: starting the main session…\n');
    if (this.opts.mainSessionId) {
      const agent = (await listAgentsAsync()).find(
        (a) => a.sessionId === this.opts.mainSessionId || a.id === this.opts.mainSessionId,
      );
      if (!agent)
        throw new Error(`No running session ${this.opts.mainSessionId} (see \`claude agents\`)`);
      this.main = adoptMainSession(this.opts.cwd, agent);
    } else {
      this.main = await ensureMainSession(this.opts.cwd, this.opts.claudeArgs, this.opts.prompt);
    }
    await this.refresh();

    this.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h');
    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdin.on('data', this.onData);
    this.stdout.on('resize', this.onResize);
    process.on('SIGTERM', this.onSignal);
    process.on('SIGHUP', this.onSignal);

    // Lets `pit fork` in another terminal know a UI is open to start cloud and agent panes.
    writeJsonAtomic(tuiPidFile(this.ctx.repoId), {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    this.mainPaneId = this.main.sessionId;
    this.addSessionPane(this.main.sessionId, this.main.shortId);
    this.restoreLayout();
    this.reconcilePanes();
    if (this.cfg.untrusted?.length) {
      this.flash(
        `.pitstop.json asks to run commands; ignored until you run \`pit trust\`: ${this.cfg.untrusted.join('; ')}`,
        STYLE.warn,
        12000,
      );
    } else {
      const notice = takeNotice();
      if (notice) this.flash(notice, STYLE.ok, 12000);
      else this.flash('pitstop ready · ctrl+\\ f to fork · ctrl+\\ ? for help', STYLE.ok, 6000);
    }
    startBackgroundUpgrade(this.cfg.autoUpgrade);
    this.timers.push(
      setInterval(() => void this.refresh().then(() => this.reconcilePanes()), 1500),
    );
    this.timers.push(setInterval(() => void this.scanRadar(), this.cfg.radarIntervalMs));
    this.timers.push(setInterval(() => this.updateCosts(), 10_000));
    this.updateCosts();
    this.layoutAndRender();
    return new Promise((resolve) => (this.exitResolve = resolve));
  }

  // ---- sessions and panes -------------------------------------------------

  private label(id: string): string {
    if (id === this.main?.sessionId) return 'main';
    const b = this.branchByPane(id);
    return b?.name ?? this.panes.get(id)?.title ?? id.slice(0, 8);
  }

  /** Pane id for a fork: its Claude session id, or fork:<name> for cloud and agent forks. */
  private paneIdOf(b: BranchRecord): string {
    return b.sessionId ?? `fork:${b.name}`;
  }

  private branchByPane(id: string): BranchRecord | undefined {
    return this.branches.find((b) => b.sessionId === id || `fork:${b.name}` === id);
  }

  /** A pane running a cloud or agent fork's own program (not `claude attach`). */
  private addLaunchPane(b: BranchRecord, resume = false): void {
    const id = this.paneIdOf(b);
    if (this.panes.has(id) || !b.launch) return;
    const kind = branchKind(b) === 'cloud' ? 'cloud' : 'agent';
    const args = resume && b.resumeArgs ? b.resumeArgs : b.launch.args;
    const size = this.paneSizeGuess();
    const pane: Pane = new Pane({
      id,
      kind,
      title: b.name,
      cmd: b.launch.cmd,
      args,
      cwd: b.launch.cwd,
      env: b.launch.env,
      cols: size.cols,
      rows: size.rows,
      onUpdate: () => {
        if (kind === 'cloud' && !this.branchByPane(id)?.cloudSessionId) {
          const found = parseCloudSession(pane.lines().join('\n'));
          if (found) {
            updateBranch(b.repoId, b.name, { cloudSessionId: found.id, cloudUrl: found.url });
            this.flash(`cloud fork ${b.name}: ${found.url}`, STYLE.ok, 10000);
          }
        }
        this.scheduleRender();
      },
      onExit: () => {
        const cur = this.branchByPane(id);
        if (kind === 'agent' && cur && LIVE_STATES.includes(cur.state)) {
          updateBranch(b.repoId, b.name, { state: 'idle', note: `${b.agent ?? 'agent'} exited` });
        }
      },
    });
    if (kind === 'agent' && b.resumeArgs) pane.setCommand(b.launch.cmd, b.resumeArgs);
    this.panes.set(id, pane);
    if (!this.order.includes(id)) this.order.push(id);
    if (b.state === 'starting' || b.state === 'idle')
      updateBranch(b.repoId, b.name, { state: 'running' });
  }

  private addSessionPane(sessionId: string, shortId?: string): void {
    if (this.panes.has(sessionId)) return;
    const size = this.paneSizeGuess();
    const pane = new Pane({
      id: sessionId,
      kind: 'session',
      title: this.label(sessionId),
      cmd: claudeBin(),
      args: ['attach', shortId ?? sessionId.slice(0, 8)],
      cwd: this.ctx.top,
      cols: size.cols,
      rows: size.rows,
      onUpdate: () => this.scheduleRender(),
    });
    this.panes.set(sessionId, pane);
    if (!this.order.includes(sessionId)) this.order.push(sessionId);
    if (!this.focus) this.focus = sessionId;
  }

  private addCommandPane(id: string, title: string, shell: string, cwd: string): void {
    this.closePane(id);
    const size = this.paneSizeGuess();
    const pane = new Pane({
      id,
      kind: 'command',
      title,
      cmd: process.env.SHELL && !process.env.SHELL.endsWith('fish') ? process.env.SHELL : '/bin/sh',
      args: ['-c', shell],
      cwd,
      cols: size.cols,
      rows: size.rows,
      onUpdate: () => this.scheduleRender(),
      onExit: () => setTimeout(() => this.closePane(id), 50),
    });
    this.panes.set(id, pane);
    this.order.push(id);
    this.focus = id;
    this.zoom = undefined;
    this.layoutAndRender();
  }

  private closePane(id: string): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    pane.dispose();
    this.panes.delete(id);
    this.order = this.order.filter((o) => o !== id);
    if (this.zoom === id) this.zoom = undefined;
    if (this.focus === id) this.focus = this.main.sessionId;
    this.layoutAndRender();
  }

  private paneSizeGuess(): { cols: number; rows: number } {
    const side = this.cols >= this.cfg.splitColumns;
    return {
      cols: side ? Math.floor(this.cols / 2) : this.cols,
      rows: Math.max(5, Math.floor((this.rows - 2) / 2)),
    };
  }

  /** Open panes for live pane-mode forks (including ones made with `pit fork` elsewhere); close finished ones. */
  private reconcilePanes(): void {
    if (this.stopped) return;
    let changed = false;
    for (const b of this.branches) {
      const live = LIVE_STATES.includes(b.state) && b.state !== 'deferred';
      if (
        b.sessionId &&
        b.mode === 'pane' &&
        live &&
        this.agents.has(b.sessionId) &&
        !this.panes.has(b.sessionId)
      ) {
        this.addSessionPane(b.sessionId, b.shortId);
        changed = true;
      }
      const kind = branchKind(b);
      if (b.launch && live && !this.panes.has(this.paneIdOf(b))) {
        // Agents come back after a restart (resumed); a cloud pane is only needed to start the session.
        if (kind === 'agent') {
          this.addLaunchPane(b, b.state !== 'starting');
          changed = true;
        } else if (kind === 'cloud' && b.state === 'starting') {
          this.addLaunchPane(b);
          changed = true;
        }
      }
      const id = this.paneIdOf(b);
      if (this.panes.has(id) && (b.state === 'merged' || b.state === 'discarded')) {
        this.closePane(id);
        changed = true;
      }
    }
    // A fork whose record was removed (deleted and forgotten) takes its pane with it.
    for (const [id, pane] of this.panes) {
      if (pane.kind === 'command' || id === this.mainPaneId) continue;
      if (!this.branchByPane(id)) {
        this.closePane(id);
        changed = true;
      }
    }
    for (const [id, pane] of this.panes) {
      if (pane.kind !== 'command') pane.title = this.label(id);
    }
    if (changed) this.layoutAndRender();
    else this.scheduleRender();
  }

  private saveLayout(): void {
    writeJsonAtomic(path.join(repoStateDir(this.ctx.repoId), 'layout.json'), {
      order: this.order.filter((id) => this.panes.get(id)?.kind !== 'command'),
      focus: this.focus,
      zoom: this.zoom,
    } satisfies SavedLayout);
  }

  private restoreLayout(): void {
    const saved = readJson<SavedLayout>(path.join(repoStateDir(this.ctx.repoId), 'layout.json'));
    if (!saved) return;
    for (const id of saved.order) {
      if (id === this.main.sessionId) continue;
      const b = this.branchByPane(id);
      if (!b || !LIVE_STATES.includes(b.state)) continue;
      if (b.sessionId && this.agents.has(id)) this.addSessionPane(id, b.shortId);
      else if (branchKind(b) === 'agent') this.addLaunchPane(b, true);
    }
    if (saved.focus && this.panes.has(saved.focus)) this.focus = saved.focus;
    if (saved.zoom && this.panes.has(saved.zoom)) this.zoom = saved.zoom;
  }

  // ---- background refresh -------------------------------------------------

  private async refresh(): Promise<void> {
    const agents = await listAgentsAsync();
    this.agents = new Map(agents.map((a) => [a.sessionId, a]));
    // Main is keyed by the id it started with; its conversation id can change since.
    const main = findAgent(agents, this.main.sessionId);
    if (main) this.agents.set(this.main.sessionId, main);
    this.branches = listBranches(this.ctx.repoId);
    if (Date.now() - this.lastCloudCheck > 30_000) {
      this.lastCloudCheck = Date.now();
      void this.checkCloudForks();
    }
    for (const b of this.branches) {
      if (!b.sessionId || !LIVE_STATES.includes(b.state)) continue;
      const agent = this.agents.get(b.sessionId);
      // Budgets: Claude Code can't cap a background session's spend, so pitstop stops it.
      const cost = this.costs.get(b.sessionId)?.usd;
      if (b.budgetUsd && cost !== undefined && cost > b.budgetUsd && agent) {
        stopSession(b.shortId ?? b.sessionId);
        updateBranch(b.repoId, b.name, {
          state: 'done',
          note: `stopped at its $${b.budgetUsd} budget`,
        });
        this.flash(`fork ${b.name} reached its $${b.budgetUsd} budget and was stopped`, STYLE.warn);
      }
      if (
        b.mode === 'bg' &&
        b.state === 'running' &&
        agent &&
        agent.status === 'idle' &&
        agent.state === 'done'
      ) {
        updateBranch(b.repoId, b.name, { state: 'done' });
        this.flash(`background fork ${b.name} finished · ctrl+\\ m to merge`, STYLE.ok, 10000);
      }
    }
  }

  /** A cloud fork is ready once its session pushes past the starting point. */
  private async checkCloudForks(): Promise<void> {
    for (const b of this.branches) {
      if (branchKind(b) !== 'cloud' || !['starting', 'running'].includes(b.state)) continue;
      const head = await remoteHead(b);
      if (!head || head === b.remoteHead) continue;
      const next = { ...b, remoteHead: head };
      const ready = cloudForkReady(next);
      updateBranch(b.repoId, b.name, {
        remoteHead: head,
        ...(ready ? { state: 'done' as const } : {}),
      });
      if (ready)
        this.flash(`cloud fork ${b.name} pushed its work · ctrl+\\ m to merge`, STYLE.ok, 12000);
    }
  }

  private async scanRadar(): Promise<void> {
    if (this.stopped) return;
    try {
      const touched = await collectTouched(this.ctx.top, this.branches);
      this.overlaps = findOverlaps(touched);
      for (const o of this.overlaps) {
        const key = overlapKey(o);
        if (this.notified.has(key)) continue;
        this.notified.add(key);
        for (const s of o.sessions) {
          const to =
            s === 'main'
              ? this.agents.get(this.main.sessionId)?.sessionId
              : this.branches.find((b) => b.name === s)?.sessionId;
          if (!to) continue;
          sendInbox({
            to,
            from: 'pitstop radar',
            kind: 'radar',
            text: `Heads up: ${o.file} is being changed by ${o.sessions.join(' and ')} at the same time. Keep your change to it small, or coordinate before editing it further.`,
            files: [o.file],
          });
        }
        this.flash(`!! ${o.file} is changed by ${o.sessions.join(' + ')}`, STYLE.warn, 8000);
      }
      this.scheduleRender();
    } catch {
      // radar is best effort
    }
  }

  private updateCosts(): void {
    for (const id of [this.main?.sessionId, ...this.branches.map((b) => b.sessionId)]) {
      if (!id) continue;
      // Costs are keyed by pane id, but read from the conversation's current id.
      const c = sessionCost(this.agents.get(id)?.sessionId ?? id);
      if (c) this.costs.set(id, c);
    }
    this.scheduleRender();
  }

  // ---- input --------------------------------------------------------------

  private onData = (buf: Buffer): void => {
    let data = buf.toString('utf8');
    // An overlay takes one key; anything typed after it in the same chunk carries on.
    while (this.overlay && data) {
      const n = firstKeyLength(data);
      this.overlayKey(data.slice(0, n));
      data = data.slice(n);
    }
    if (!data) return;
    if (this.prompt) {
      // Feed Tab-separated pieces one at a time so quick repeated Tabs each count.
      for (const [i, piece] of data.split('\t').entries()) {
        const p = this.prompt;
        if (!p) break;
        if (i > 0) p.onTab?.();
        const r = piece ? p.editor.feed(piece) : undefined;
        if (r === 'submit') {
          this.prompt = undefined;
          if (p.editor.value.trim()) p.onSubmit(p.editor.value.trim());
        } else if (r === 'cancel') this.prompt = undefined;
      }
      return this.scheduleRender();
    }
    for (const action of this.router.feed(data)) {
      const pane = this.panes.get(this.focus);
      switch (action.type) {
        case 'forward':
          if (action.data.includes('\x1b[200~')) pane?.paste(action.data);
          else pane?.write(action.data);
          break;
        case 'prefix':
          this.flash(
            'ctrl+\\ … f fork · b bg fork · m merge · d diff · t tree · x delete · z zoom · ? help',
            STYLE.prompt,
            3000,
          );
          break;
        case 'cancel':
          this.message = undefined;
          break;
        case 'command':
          this.message = undefined;
          this.command(action.command);
          break;
        case 'mouse':
          this.mouse(action.button, action.x, action.y, action.release);
          break;
      }
    }
    this.scheduleRender();
  };

  private mouse(button: number, x: number, y: number, release: boolean): void {
    const slot = this.lastLayout?.panes.find(
      (p) => x >= p.rect.x && x < p.rect.x + p.rect.w && y >= p.rect.y && y < p.rect.y + p.rect.h,
    );
    if (!slot) {
      if (!release && this.lastLayout && y === this.lastLayout.status.y) this.clickStatus(x);
      return;
    }
    const isWheel = button >= 64 && button < 128;
    if (!release && !isWheel && slot.id !== this.focus) {
      this.focus = slot.id;
      this.layoutAndRender();
      return;
    }
    const pane = this.panes.get(slot.id);
    if (pane?.mouseTracking && pane.sgrMouse && y >= slot.body.y) {
      pane.write(
        `\x1b[<${button};${x - slot.body.x + 1};${y - slot.body.y + 1}${release ? 'm' : 'M'}`,
      );
    }
  }

  /** Clickable spots in the bottom bar: session tabs (focus) and buttons (run a command). */
  private statusHits: { x0: number; x1: number; id?: string; command?: Command }[] = [];

  private clickStatus(x: number): void {
    const hit = this.statusHits.find((h) => x >= h.x0 && x < h.x1);
    if (hit?.command) {
      this.message = undefined;
      this.command(hit.command);
      this.scheduleRender();
    } else if (hit?.id) {
      this.focus = hit.id;
      this.layoutAndRender();
    }
  }

  private overlayKey(data: string): void {
    const o = this.overlay!;
    if (o.kind === 'confirm') {
      if (/^[yY]/.test(data) || o.yesKeys?.includes(data)) {
        this.overlay = undefined;
        o.onYes();
      } else if (o.alt && data === o.alt.key) {
        this.overlay = undefined;
        o.alt.run();
      } else if (/^[nN\x1b\x03q]/.test(data)) this.overlay = undefined;
    } else if (o.kind === 'pick') {
      const n = Number(data[0]);
      if (n >= 1 && n <= o.items.length) {
        this.overlay = undefined;
        o.onPick(o.items[n - 1]!.value);
      } else if (/^[\x1b\x03q]/.test(data)) this.overlay = undefined;
    } else {
      this.overlay = undefined;
      o.keys?.find((k) => k.key === data)?.run();
    }
    this.scheduleRender();
  }

  private visibleIds(): string[] {
    return this.lastLayout?.panes.map((p) => p.id) ?? [this.focus];
  }

  private command(c: Command): void {
    if (c.startsWith('jump:')) {
      const id = this.order[Number(c.slice(5)) - 1];
      if (id) this.focus = id;
      return this.layoutAndRender();
    }
    switch (c) {
      case 'next':
      case 'down':
      case 'prev':
      case 'up': {
        const ids = this.visibleIds();
        const i = ids.indexOf(this.focus);
        const step = c === 'next' || c === 'down' ? 1 : -1;
        this.focus = ids[(i + step + ids.length) % ids.length] ?? this.focus;
        return this.layoutAndRender();
      }
      case 'zoom':
        this.zoom = this.zoom ? undefined : this.focus;
        return this.layoutAndRender();
      case 'fork':
      case 'bg-fork':
        return this.askFork(c === 'bg-fork' ? 'bg' : 'pane');
      case 'merge':
        return this.withFork('Merge which fork?', (b) => this.confirmMerge(b));
      case 'diff':
        return this.withFork('Diff which fork?', (b) => this.showDiff(b));
      case 'pull':
        return this.withFork('Pull main into which fork?', (b) => this.pull(b));
      case 'delete':
        return this.withFork('Delete which fork?', (b) => this.confirmDelete(b));
      case 'tree':
        return this.showTree();
      case 'reattach': {
        const pane = this.panes.get(this.focus);
        if (pane?.kind === 'cloud') {
          const b = this.branchByPane(this.focus);
          return this.flash(
            b?.cloudUrl
              ? `open the cloud session: ${b.cloudUrl}`
              : 'the cloud session has no link yet',
            STYLE.warn,
            10000,
          );
        }
        if (pane?.kind === 'session' || pane?.kind === 'agent') pane.respawn();
        return this.flash(pane?.kind === 'agent' ? 'resumed the agent' : 're-attached', STYLE.ok);
      }
      case 'report':
        return void this.op('writing report…', async () => {
          const file = writeReport(
            await buildReport(this.ctx.top, {
              mainLabel: this.main.name,
              mainSessionId: this.main.sessionId,
            }),
          );
          this.flash(`report written: ${file}`, STYLE.ok, 15000);
        });
      case 'send':
        return this.withFork(
          'Message which cloud fork?',
          (b) => this.askCloudMessage(b),
          (b) => branchKind(b) === 'cloud',
        );
      case 'help':
        this.overlay = { kind: 'text', title: 'pitstop keys', lines: HELP };
        return;
      case 'quit': {
        const agentPanes = [...this.panes.values()].filter((p) => p.kind === 'agent' && !p.exited);
        this.overlay = {
          kind: 'confirm',
          title: 'Quit pit?',
          lines: [
            'Every Claude session keeps running in the background.',
            'Run `pit` here again to reopen the same panes.',
            ...(agentPanes.length
              ? [
                  '',
                  `These agent panes stop: ${agentPanes.map((p) => p.title).join(', ')}.`,
                  'Their worktrees and branches are kept; pit resumes them next time.',
                ]
              : []),
          ],
          onYes: () => void this.stop(),
          yesKeys: ['\r', '\x1b[21~'],
        };
        return;
      }
    }
  }

  /** Run `fn` on the focused fork, or let the user pick one when main (or nothing) is focused. */
  private withFork(
    title: string,
    fn: (b: BranchRecord) => void,
    only: (b: BranchRecord) => boolean = () => true,
  ): void {
    // Act on the record as it is on disk now; hooks may have changed it since the last refresh.
    const fresh = (b: BranchRecord) => loadBranch(b.repoId, b.name) ?? b;
    const focused = this.branchByPane(this.focus);
    if (focused && LIVE_STATES.includes(focused.state) && only(focused)) return fn(fresh(focused));
    const live = this.branches.filter((b) => LIVE_STATES.includes(b.state) && only(b));
    if (!live.length) return this.flash('No matching forks. Press ctrl+\\ f to fork.', STYLE.warn);
    if (live.length === 1) return fn(fresh(live[0]!));
    this.overlay = {
      kind: 'pick',
      title,
      items: live.slice(0, 9).map((b) => ({
        label: `${b.name}  ${sessionState(b.sessionId ? this.agents.get(b.sessionId) : undefined, b)}  ${b.mode}`,
        value: b.name,
      })),
      onPick: (name) => {
        const b = this.branches.find((x) => x.name === name);
        if (b) fn(fresh(b));
      },
    };
  }

  private askFork(mode: 'pane' | 'bg'): void {
    const focusedPane = this.panes.get(this.focus);
    if (focusedPane && (focusedPane.kind === 'agent' || focusedPane.kind === 'cloud')) {
      return this.flash(
        'Only Claude sessions can be forked. Focus main or a Claude fork first.',
        STYLE.warn,
      );
    }
    const parentId = focusedPane?.kind === 'session' ? this.focus : this.main.sessionId;
    const choices = [undefined, ...Object.keys(this.cfg.presets)];
    let index = 0;
    const label = () => {
      const chosen = choices[index];
      const what = mode === 'bg' ? 'background fork' : 'fork';
      return `${what} of ${this.label(parentId)} · ${chosen ? `preset: ${chosen}` : 'no preset'} (Tab) · task`;
    };
    const prompt: Prompt = {
      label: label(),
      editor: new LineEditor(),
      onTab: () => {
        index = (index + 1) % choices.length;
        prompt.label = label();
      },
      onSubmit: (value) => {
        const typed = parseTaskInput(value, this.cfg.presets);
        this.startFork(parentId, typed.task, typed.preset ?? choices[index], mode);
      },
    };
    this.prompt = prompt;
  }

  /** Fork, asking first when the fork would push to GitHub or send a summary to another provider. */
  private startFork(
    parentId: string,
    task: string,
    preset: string | undefined,
    mode: 'pane' | 'bg',
    confirmed = false,
  ): void {
    void this.op(`forking ${this.label(parentId)}…`, async () => {
      let b: BranchRecord;
      try {
        b = await forkSession({
          cwd: this.ctx.top,
          parentSessionId: parentId,
          task,
          preset,
          mode,
          confirmed,
        });
      } catch (err) {
        if (!(err instanceof ConfirmationNeeded)) throw err;
        const agent = preset ? this.cfg.presets[preset]?.agent : undefined;
        this.overlay = {
          kind: 'confirm',
          title:
            err.what === 'cloud' ? 'Start a cloud fork?' : `Fork into ${agent ?? 'another agent'}?`,
          lines: [err.message, '', `Task: ${task}`],
          onYes: () => {
            if (err.what === 'agent' && agent) recordAgentConsent(this.ctx.repoId, agent);
            this.startFork(parentId, task, preset, mode, true);
          },
        };
        return;
      }
      await this.refresh();
      const kind = branchKind(b);
      if (kind === 'claude' && mode === 'pane' && b.sessionId) {
        this.addSessionPane(b.sessionId, b.shortId);
        this.focus = b.sessionId;
      } else if (kind !== 'claude') {
        this.addLaunchPane(b);
        this.focus = this.paneIdOf(b);
      }
      this.zoom = undefined;
      const how =
        kind === 'cloud'
          ? ` in the cloud; its work comes back on ${b.gitBranch}`
          : kind === 'agent'
            ? ` with ${b.agent}, starting from a summary of this conversation`
            : b.forkMethod === 'sealed'
              ? ' (parent was mid-turn: sealed copy, its running tool is not repeated)'
              : '';
      this.flash(`forked ${b.name}${how}`, STYLE.ok, 8000);
      this.layoutAndRender();
    });
  }

  private askCloudMessage(b: BranchRecord): void {
    this.prompt = {
      label: `message to cloud fork ${b.name}`,
      editor: new LineEditor(),
      onSubmit: (value) =>
        void this.op(`sending to ${b.name}…`, async () => {
          await messageCloudFork(b, value);
          this.flash(`sent to the cloud session of ${b.name}`, STYLE.ok);
        }),
    };
  }

  private confirmMerge(b: BranchRecord): void {
    const gate =
      (b.testGate ?? this.cfg.testGate) && this.cfg.test
        ? `Runs \`${this.cfg.test}\` first.`
        : 'No test gate.';
    this.overlay = {
      kind: 'confirm',
      title: `Merge ${b.name}?`,
      lines: [
        `Task: ${b.task}`,
        gate,
        ...(branchKind(b) === 'cloud'
          ? [
              `Fetches ${b.gitBranch} from origin first${b.state === 'done' ? '' : " (the cloud session hasn't pushed yet)"}.`,
            ]
          : []),
        ...(branchKind(b) === 'agent' && !this.panes.get(this.paneIdOf(b))?.exited
          ? [`${b.agent} is still running; its uncommitted work is committed as it is now.`]
          : []),
        "pitstop picks the safe way: a merge commit if main's tree is clean, unstaged",
        'changes if main is editing other files, otherwise it leaves the branch ready.',
      ],
      onYes: () =>
        void this.op(`merging ${b.name}…`, async () => {
          const res = await mergeBranch(this.ctx.top, b.name);
          await this.refresh();
          this.reconcilePanes();
          const lines = [`Result: ${res.strategy}`, `Why: ${res.reason}`];
          if (res.files.length) lines.push(`Files: ${res.files.join(', ')}`);
          if (res.gate)
            lines.push(
              '',
              `Test gate ${res.gate.ok ? 'passed' : `failed (exit ${res.gate.code})`}:`,
              ...res.gate.tail.split('\n').slice(-12),
            );
          if (res.strategy !== 'blocked')
            lines.push('', 'The parent session gets a note after its next tool call.');
          this.overlay = { kind: 'text', title: `merge ${b.name}`, lines };
        }),
    };
  }

  private confirmDelete(b: BranchRecord): void {
    const run = (conversation: boolean) =>
      void this.op(`deleting ${b.name}…`, async () => {
        const r = await deleteFork(this.ctx.top, b.name, { conversation });
        await this.refresh();
        this.reconcilePanes();
        const extra = conversation
          ? r.notes.length
            ? ` · ${r.notes.join('; ')}`
            : ' and its conversation'
          : '';
        this.flash(`deleted ${b.name}${extra}`, STYLE.ok, 8000);
      });
    this.overlay = {
      kind: 'confirm',
      title: `Delete ${b.name}?`,
      lines: [
        'Stops the fork and deletes its worktree and its branch.',
        'Its conversation stays in Claude Code unless you press c.',
      ],
      onYes: () => run(false),
      alt: { key: 'c', label: 'delete + conversation (no undo)', run: () => run(true) },
    };
  }

  private showDiff(b: BranchRecord): void {
    if (!b.worktree || !fs.existsSync(b.worktree))
      return this.flash(`${b.name} hasn't changed any files yet`, STYLE.warn);
    const pager =
      runSync('sh', ['-c', 'command -v delta']).code === 0 ? 'delta --paging=always' : 'less -R';
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const cmd = `{ git -C ${q(b.worktree)} --no-pager diff --stat ${b.snapshotCommit}; echo; git -C ${q(b.worktree)} --no-pager diff --color=always ${b.snapshotCommit}; } | ${pager}`;
    this.addCommandPane(`diff:${b.name}`, `diff ${b.name} (q to close)`, cmd, b.worktree);
  }

  private pull(b: BranchRecord): void {
    void this.op(`pulling main into ${b.name}…`, async () => {
      const { outcome } = pullFromParent(this.ctx.top, b.name);
      const text = {
        ok: `${b.name} now includes main's latest commits`,
        'up-to-date': `${b.name} already has main's latest commits`,
        'needs-commit': `${b.name} has uncommitted work; asked it to commit first`,
        conflict: `rebasing ${b.name} onto main conflicts; left it as it was`,
        'no-worktree': `${b.name} hasn't started editing yet, nothing to pull into`,
      }[outcome];
      this.flash(text, outcome === 'ok' || outcome === 'up-to-date' ? STYLE.ok : STYLE.warn, 8000);
    });
  }

  private showTree(): void {
    void (async () => {
      const touched = await collectTouched(this.ctx.top, this.branches).catch(
        () => new Map<string, string[]>(),
      );
      this.overlay = {
        kind: 'text',
        title: `branch tree · ${this.ctx.name}`,
        lines: treeLines({
          mainLabel: `${this.main.name} (main)`,
          mainSessionId: this.main.sessionId,
          branches: this.branches,
          agents: [...this.agents.values()],
          costs: this.costs,
          touched,
          overlaps: this.overlaps,
          all: true,
        }),
        keys: finishedForks(this.ctx.top).length
          ? [{ key: 'c', label: 'clear merged and deleted forks', run: () => this.confirmClear() }]
          : [],
      };
      this.scheduleRender();
    })();
  }

  private confirmClear(): void {
    const forks = finishedForks(this.ctx.top);
    if (!forks.length) return;
    this.overlay = {
      kind: 'confirm',
      title: `Clear ${forks.length} finished fork${forks.length === 1 ? '' : 's'} from the history?`,
      lines: [
        ...forks
          .slice(0, 8)
          .map((b) => `${b.name}  (${b.state === 'merged' ? 'merged' : 'deleted'})`),
        ...(forks.length > 8 ? [`… and ${forks.length - 8} more`] : []),
        '',
        'They leave the tree and the report. Their conversations stay unless you press c.',
      ],
      onYes: () => this.clear(false),
      alt: { key: 'c', label: 'clear + conversations (no undo)', run: () => this.clear(true) },
    };
  }

  private clear(conversation: boolean): void {
    void this.op('clearing history…', async () => {
      const done = await clearHistory(this.ctx.top, { conversation });
      await this.refresh();
      this.reconcilePanes();
      this.flash(
        `cleared ${done.length} fork${done.length === 1 ? '' : 's'} from the history`,
        STYLE.ok,
      );
    });
  }

  /** Run a slow action with a status-bar spinner; errors become a message instead of a crash. */
  private async op(label: string, fn: () => Promise<void>): Promise<void> {
    if (this.busyLabel) return this.flash(`busy: ${this.busyLabel}`, STYLE.warn);
    this.busyLabel = label;
    this.scheduleRender();
    try {
      await fn();
    } catch (err) {
      this.flash(err instanceof Error ? err.message : String(err), STYLE.error, 12000);
    } finally {
      this.busyLabel = undefined;
      this.scheduleRender();
    }
  }

  private flash(text: string, style: string, ms = 5000): void {
    this.message = { text, style, until: Date.now() + ms };
    this.scheduleRender();
    setTimeout(() => this.scheduleRender(), ms + 50);
  }

  // ---- drawing ------------------------------------------------------------

  private onResize = (): void => {
    this.prev = undefined;
    this.layoutAndRender();
  };

  private layoutAndRender(): void {
    if (this.stopped) return;
    const ids = this.order.filter((id) => this.panes.has(id));
    const layout = computeLayout({
      cols: this.cols,
      rows: this.rows,
      ids,
      focus: this.focus,
      zoom: this.zoom,
      visibleForks: this.cfg.visibleForks,
      splitColumns: this.cfg.splitColumns,
    });
    for (const slot of layout.panes) this.panes.get(slot.id)?.resize(slot.body.w, slot.body.h);
    this.lastLayout = layout;
    this.saveLayout();
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderTimer || this.stopped) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 16);
  }

  private render(): void {
    if (this.stopped || !this.lastLayout) return;
    const layout = this.lastLayout;
    const screen = new Screen(this.cols, this.rows);
    for (const slot of layout.panes) {
      const pane = this.panes.get(slot.id);
      if (!pane) continue;
      screen.blit(pane.term, slot.body);
      this.drawFrame(screen, slot);
    }
    this.drawStatus(screen, layout);
    if (this.overlay) this.drawOverlay(screen);
    let out = diffScreens(this.prev, screen);
    this.prev = screen;
    out += this.cursor(layout);
    if (out) this.stdout.write(out);
  }

  private cursor(layout: Layout): string {
    if (this.overlay) return '\x1b[?25l';
    if (this.prompt) {
      const x = Math.min(
        this.cols - 1,
        textWidth(` ${this.prompt.label}: `) + textWidth(this.prompt.editor.value),
      );
      return `\x1b[${layout.status.y + 1};${x + 1}H\x1b[?25h`;
    }
    const slot = layout.panes.find((p) => p.id === this.focus);
    const pane = slot && this.panes.get(slot.id);
    if (!slot || !pane || !pane.cursorVisible || pane.exited) return '\x1b[?25l';
    const buf = pane.term.buffer.active;
    if (buf.viewportY !== buf.baseY) return '\x1b[?25l';
    const x = slot.body.x + Math.min(buf.cursorX, slot.body.w - 1);
    const y = slot.body.y + Math.min(buf.cursorY, slot.body.h - 1);
    return `\x1b[${y + 1};${x + 1}H\x1b[?25h`;
  }

  /** Rounded frame: name, state and parent in the top border; notices and cost in the bottom one. */
  private drawFrame(screen: Screen, slot: PaneSlot): void {
    const { id, rect: r } = slot;
    const focused = id === this.focus;
    const isMain = id === this.mainPaneId;
    const border = focused ? STYLE.frameFocus : STYLE.frame;
    const right = r.x + r.w - 1;
    const top = r.y;
    const bottom = slot.footer.y;
    screen.fill({ x: r.x + 1, y: top, w: r.w - 2, h: 1 }, '─', border);
    screen.fill({ x: r.x + 1, y: bottom, w: r.w - 2, h: 1 }, '─', border);
    for (let y = top + 1; y < bottom; y++) {
      screen.set(r.x, y, { ch: '│', w: 1, sgr: border });
      screen.set(right, y, { ch: '│', w: 1, sgr: border });
    }
    screen.set(r.x, top, { ch: '╭', w: 1, sgr: border });
    screen.set(right, top, { ch: '╮', w: 1, sgr: border });
    screen.set(r.x, bottom, { ch: '╰', w: 1, sgr: border });
    screen.set(right, bottom, { ch: '╯', w: 1, sgr: border });

    const pane = this.panes.get(id);
    const b = this.branchByPane(id);
    const state =
      pane?.kind === 'command'
        ? 'running'
        : sessionState(pane?.kind === 'session' ? this.agents.get(id) : undefined, b);
    const idx = this.order.indexOf(id) + 1;
    const kind = b ? branchKind(b) : undefined;
    const parent = b
      ? `${kind === 'agent' ? `${b.agent} · ` : kind === 'cloud' ? 'cloud · ' : ''}fork of ${b.parentBranch ?? 'main'}`
      : '';
    const titleStyle = focused ? STYLE.titleFocus : isMain ? STYLE.titleMain : STYLE.title;
    this.borderSegments(screen, r.x + 1, top, right - 1, [
      { text: `${idx > 0 ? `${idx} ` : ''}${this.label(id)}`, style: titleStyle },
      { text: `${stateGlyph(state)} ${state}`, style: stateStyle(state) },
      ...(parent ? [{ text: parent, style: STYLE.meta }] : []),
    ]);

    const notice =
      pane?.exited && pane.kind === 'session'
        ? 'detached · ctrl+\\ r to re-attach'
        : pane?.inAgentView
          ? 'agent view · Enter returns, or ctrl+\\ r'
          : this.zoom === id
            ? 'zoomed · ctrl+\\ z to split'
            : '';
    const cost = this.costs.get(id);
    const costText = cost ? ` $${cost.usd.toFixed(2)} ` : '';
    const costX = right - 1 - textWidth(costText);
    if (costText && costX > r.x + 2) screen.text(costX, bottom, costText, STYLE.meta);
    if (notice)
      this.borderSegments(screen, r.x + 1, bottom, (costText ? costX : right) - 1, [
        { text: notice, style: STYLE.notice },
      ]);
  }

  /** Write ` text ` segments into a border row, joined by the border line, clipped at `maxX`. */
  private borderSegments(
    screen: Screen,
    x: number,
    y: number,
    maxX: number,
    segs: { text: string; style: string }[],
  ): void {
    x += 1;
    for (const [i, seg] of segs.entries()) {
      if (i > 0) x += 1; // one border cell between segments
      const room = maxX - x;
      if (room < 4) return;
      const t = ` ${truncate(seg.text, room - 2)} `;
      x = screen.text(x, y, t, seg.style, room);
    }
  }

  private drawStatus(screen: Screen, layout: Layout): void {
    const r = layout.status;
    screen.fill(r, ' ', STYLE.status);
    if (this.prompt) {
      const label = ` ${this.prompt.label}: `;
      const x = screen.text(0, r.y, label, STYLE.prompt);
      screen.text(x, r.y, this.prompt.editor.value, STYLE.status);
      return;
    }
    let x = 1;
    this.statusHits = [];
    this.order.forEach((id, i) => {
      const kind = this.panes.get(id)?.kind;
      if (!kind || kind === 'command') return;
      const state = sessionState(this.agents.get(id), this.branchByPane(id));
      const hidden = layout.hidden.includes(id);
      const focused = id === this.focus;
      const text = `${focused ? '▸' : ' '}${i + 1} ${stateGlyph(state)} ${this.label(id)}${hidden ? ' ⋯' : ''} `;
      const style = focused
        ? STYLE.statusFocus
        : id === this.mainPaneId
          ? STYLE.statusMain
          : STYLE.statusFork;
      const x0 = x;
      x = screen.text(x, r.y, text, style, Math.max(0, r.w - x - 30));
      this.statusHits.push({ x0, x1: x, id });
    });
    const live = this.branches.filter((b) => LIVE_STATES.includes(b.state));
    const bg = live.filter((b) => b.mode === 'bg' && branchKind(b) === 'claude');
    const cloud = live.filter(
      (b) => branchKind(b) === 'cloud' && !this.panes.has(this.paneIdOf(b)),
    );
    if (bg.length) x = screen.text(x + 1, r.y, `+${bg.length} bg`, STYLE.statusFork);
    if (cloud.length) {
      const ready = cloud.filter((b) => b.state === 'done').length;
      x = screen.text(
        x + 1,
        r.y,
        `+${cloud.length} cloud${ready ? ` (${ready} ready)` : ''}`,
        STYLE.statusFork,
      );
    }
    // Buttons on the right, each labelled with its one-step key.
    const keys = this.cfg.shortKeys;
    const plan = (withKeys: boolean, buttons: typeof BUTTONS) =>
      buttons.map((bt) => ` ${bt.label}${withKeys && keys ? ` ${bt.key}` : ''} `);
    let labels = plan(true, BUTTONS);
    let shown = BUTTONS;
    const width = (ls: string[]) => ls.reduce((w, l) => w + textWidth(l) + 1, 0);
    const minMiddle = 24;
    if (width(labels) > r.w - x - minMiddle) labels = plan(false, BUTTONS);
    if (width(labels) > r.w - x - minMiddle) {
      shown = BUTTONS.filter((bt) => ['fork', 'merge', 'help', 'quit'].includes(bt.command));
      labels = plan(false, shown);
    }
    let bx = r.w - width(labels);
    if (bx - x >= 8) {
      labels.forEach((label, i) => {
        const x0 = bx;
        bx = screen.text(bx, r.y, label, shown[i]!.style ?? STYLE.button);
        this.statusHits.push({ x0, x1: bx, command: shown[i]!.command });
        bx += 1;
      });
    }
    const buttonsX = r.w - width(labels);

    // A message, warning or the cost sits between the tabs and the buttons.
    let middle: { text: string; style: string } | undefined;
    if (this.busyLabel) middle = { text: `⋯ ${this.busyLabel}`, style: STYLE.prompt };
    else if (this.message && this.message.until > Date.now()) middle = this.message;
    else if (this.overlaps.length) {
      const o = this.overlaps[0]!;
      middle = {
        text: `!! ${o.file}: ${o.sessions.join(' + ')}${this.overlaps.length > 1 ? ` (+${this.overlaps.length - 1})` : ''}`,
        style: STYLE.warn,
      };
    } else {
      const total = [...this.costs.values()].reduce((sum, c) => sum + c.usd, 0);
      if (total) middle = { text: `$${total.toFixed(2)} est`, style: STYLE.statusDim };
    }
    if (!middle) return;
    const room = buttonsX - x - 3;
    const full = ` ${middle.text} `;
    if (textWidth(full) <= room) {
      screen.text(buttonsX - 1 - textWidth(full), r.y, full, middle.style);
    } else {
      // Too long to fit beside the buttons: the message covers them until it expires.
      this.statusHits = this.statusHits.filter((h) => !h.command);
      screen.fill({ x: x + 1, y: r.y, w: r.w - x - 1, h: 1 }, ' ', STYLE.status);
      const t = ` ${truncate(middle.text, r.w - x - 4)} `;
      screen.text(r.w - textWidth(t) - 1, r.y, t, middle.style);
    }
  }

  private drawOverlay(screen: Screen): void {
    const o = this.overlay!;
    const body = o.kind === 'pick' ? o.items.map((it, i) => `${i + 1}  ${it.label}`) : o.lines;
    const extra = (k: OverlayKey) => `${k.key} ${k.label}`;
    const footer =
      o.kind === 'confirm'
        ? [
            o.yesKeys?.includes('\x1b[21~') ? 'y / Enter / F10 yes' : 'y yes',
            ...(o.alt ? [extra(o.alt)] : []),
            'n no',
          ].join(' · ')
        : o.kind === 'pick'
          ? '1-9 pick · esc cancel'
          : o.keys?.length
            ? [...o.keys.map(extra), 'any other key closes'].join(' · ')
            : 'any key to close';
    const width = Math.min(
      this.cols - 4,
      Math.max(
        textWidth(o.title) + 4,
        textWidth(footer) + 6,
        ...body.map((l) => textWidth(l) + 4),
        44,
      ),
    );
    const height = Math.min(this.rows - 3, body.length + 4);
    const x0 = Math.floor((this.cols - width) / 2);
    const y0 = Math.max(0, Math.floor((this.rows - 1 - height) / 2));
    screen.fill({ x: x0, y: y0, w: width, h: height }, ' ', STYLE.overlay);
    const xr = x0 + width - 1;
    const yb = y0 + height - 1;
    screen.fill({ x: x0 + 1, y: y0, w: width - 2, h: 1 }, '─', STYLE.overlayBorder);
    screen.fill({ x: x0 + 1, y: yb, w: width - 2, h: 1 }, '─', STYLE.overlayBorder);
    for (let y = y0 + 1; y < yb; y++) {
      screen.set(x0, y, { ch: '│', w: 1, sgr: STYLE.overlayBorder });
      screen.set(xr, y, { ch: '│', w: 1, sgr: STYLE.overlayBorder });
    }
    screen.set(x0, y0, { ch: '╭', w: 1, sgr: STYLE.overlayBorder });
    screen.set(xr, y0, { ch: '╮', w: 1, sgr: STYLE.overlayBorder });
    screen.set(x0, yb, { ch: '╰', w: 1, sgr: STYLE.overlayBorder });
    screen.set(xr, yb, { ch: '╯', w: 1, sgr: STYLE.overlayBorder });
    screen.text(x0 + 2, y0, ` ${o.title} `, STYLE.overlayTitle, width - 4);
    body
      .slice(0, height - 4)
      .forEach((line, i) =>
        screen.text(x0 + 2, y0 + 2 + i, truncate(line, width - 4), STYLE.overlay),
      );
    screen.text(x0 + 2, yb, ` ${footer} `, STYLE.overlayTitle, width - 4);
  }

  // ---- shutdown -----------------------------------------------------------

  private onSignal = (): void => void this.stop();

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.saveLayout();
    this.stopped = true;
    fs.rmSync(tuiPidFile(this.ctx.repoId), { force: true });
    for (const t of this.timers) clearInterval(t);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    for (const pane of this.panes.values()) pane.dispose(); // detaches only; sessions keep running
    this.stdin.off('data', this.onData);
    this.stdout.off('resize', this.onResize);
    process.off('SIGTERM', this.onSignal);
    process.off('SIGHUP', this.onSignal);
    this.stdout.write('\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h\x1b[?1049l');
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
    this.stdout.write(
      `pitstop: sessions are still running in the background. \`pit\` reopens them; \`pit tree\` shows them.\n`,
    );
    this.exitResolve?.();
  }
}
