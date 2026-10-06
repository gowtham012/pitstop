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
import { claudeBin, listAgentsAsync, stopSession, type AgentInfo } from '../claude/agents.js';
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
import { discardBranch, mergeBranch, pullFromParent } from '../merge/merge.js';
import { collectTouched, findOverlaps, overlapKey, type Overlap } from '../radar.js';
import { buildReport, writeReport } from '../report.js';
import { sessionCost, sessionState, stateGlyph, treeLines, type CostInfo } from '../status.js';
import { InputRouter, LineEditor, type Command } from './input.js';
import { computeLayout, type Layout } from './layout.js';
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
  | { kind: 'text'; title: string; lines: string[] }
  | { kind: 'confirm'; title: string; lines: string[]; onYes: () => void }
  | {
      kind: 'pick';
      title: string;
      items: { label: string; value: string }[];
      onPick: (value: string) => void;
    };

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
  'Press ctrl+\\ (the prefix), then one key:',
  '',
  '  f   fork the focused session into a new pane',
  '  b   fork into the background (no pane)',
  '  ← → move focus     1-9 jump to a session',
  '  z   zoom the focused pane / back to split',
  '  m   merge a fork back (safe: commit, apply or defer)',
  "  d   show a fork's diff in a pane",
  "  p   pull main's latest commits into a fork",
  '  t   branch tree        x   discard a fork',
  '  e   write a shareable report of every fork',
  '  s   send a message to a cloud fork',
  '  r   re-attach a pane   q   quit (sessions keep running)',
  '',
  'In the fork prompt, Tab cycles presets: hotfix, explore, cloud, codex, gemini, …',
  'ctrl+\\ twice sends ctrl+\\ to the pane. Click a pane to focus it.',
];

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
    this.router = new InputRouter(prefixByte(this.cfg.prefixKey));
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
      this.flash('pitstop ready · ctrl+\\ f to fork · ctrl+\\ ? for help', STYLE.ok, 6000);
    }
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
            s === 'main' ? this.main.sessionId : this.branches.find((b) => b.name === s)?.sessionId;
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
      const c = sessionCost(id);
      if (c) this.costs.set(id, c);
    }
    this.scheduleRender();
  }

  // ---- input --------------------------------------------------------------

  private onData = (buf: Buffer): void => {
    const data = buf.toString('utf8');
    if (this.overlay) return this.overlayKey(data);
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
            'ctrl+\\ … f fork · b bg fork · m merge · d diff · t tree · z zoom · ? help',
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

  private statusHits: { x0: number; x1: number; id: string }[] = [];

  private clickStatus(x: number): void {
    const hit = this.statusHits.find((h) => x >= h.x0 && x < h.x1);
    if (hit) {
      this.focus = hit.id;
      this.layoutAndRender();
    }
  }

  private overlayKey(data: string): void {
    const o = this.overlay!;
    if (o.kind === 'confirm') {
      if (/^[yY]/.test(data)) {
        this.overlay = undefined;
        o.onYes();
      } else if (/^[nN\x1b\x03q]/.test(data)) this.overlay = undefined;
    } else if (o.kind === 'pick') {
      const n = Number(data[0]);
      if (n >= 1 && n <= o.items.length) {
        this.overlay = undefined;
        o.onPick(o.items[n - 1]!.value);
      } else if (/^[\x1b\x03q]/.test(data)) this.overlay = undefined;
    } else {
      this.overlay = undefined;
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
      case 'discard':
        return this.withFork('Discard which fork?', (b) => this.confirmDiscard(b));
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

  private confirmDiscard(b: BranchRecord): void {
    this.overlay = {
      kind: 'confirm',
      title: `Discard ${b.name}?`,
      lines: [
        'Stops the fork, deletes its worktree and its branch.',
        'Its conversation is kept by Claude Code.',
      ],
      onYes: () =>
        void this.op(`discarding ${b.name}…`, async () => {
          discardBranch(this.ctx.top, b.name);
          await this.refresh();
          this.reconcilePanes();
          this.flash(`discarded ${b.name}`, STYLE.ok);
        }),
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
      };
      this.scheduleRender();
    })();
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
      this.drawHeader(screen, slot.id, slot.header);
      screen.blit(pane.term, slot.body);
      if (pane.exited && pane.kind === 'session') {
        screen.text(
          slot.body.x + 1,
          slot.body.y,
          ' detached · ctrl+\\ r to re-attach ',
          STYLE.warn,
          slot.body.w - 2,
        );
      } else if (pane.inAgentView) {
        screen.text(
          slot.body.x + 1,
          slot.body.y,
          ' agent view · Enter returns, or ctrl+\\ r ',
          STYLE.warn,
          slot.body.w - 2,
        );
      }
    }
    if (layout.divider) {
      const d = layout.divider;
      if (d.w === 1)
        for (let y = d.y; y < d.y + d.h; y++)
          screen.set(d.x, y, { ch: '│', w: 1, sgr: STYLE.divider });
      else
        for (let x = d.x; x < d.x + d.w; x++)
          screen.set(x, d.y, { ch: '─', w: 1, sgr: STYLE.divider });
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

  private drawHeader(screen: Screen, id: string, r: { x: number; y: number; w: number }): void {
    const isMain = id === this.main.sessionId;
    const focused = id === this.focus;
    const style = focused ? STYLE.headerFocus : isMain ? STYLE.headerMain : STYLE.header;
    screen.fill({ x: r.x, y: r.y, w: r.w, h: 1 }, ' ', style);
    const pane = this.panes.get(id);
    const b = this.branchByPane(id);
    const state =
      pane?.kind === 'command'
        ? 'running'
        : sessionState(pane?.kind === 'session' ? this.agents.get(id) : undefined, b);
    const idx = this.order.indexOf(id) + 1;
    const where =
      b && branchKind(b) === 'agent'
        ? ` · ${b.agent}`
        : b && branchKind(b) === 'cloud'
          ? ' · cloud'
          : '';
    const parent = b ? `${where} · fork of ${b.parentBranch ?? 'main'}` : '';
    const cost = this.costs.get(id);
    const right = `${state}${cost ? ` · $${cost.usd.toFixed(2)}` : ''} `;
    const left = ` ${idx} ${stateGlyph(state)} ${this.label(id)}${parent}`;
    screen.text(r.x, r.y, truncate(left, r.w - textWidth(right) - 1), style);
    screen.text(r.x + Math.max(0, r.w - textWidth(right)), r.y, right, style);
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
      const text = ` ${i + 1} ${this.label(id)} ${stateGlyph(state)}${hidden ? ' ⋯' : ''} `;
      const style =
        id === this.focus
          ? STYLE.statusFocus
          : id === this.main.sessionId
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
    let right: { text: string; style: string };
    if (this.busyLabel) right = { text: `⋯ ${this.busyLabel}`, style: STYLE.prompt };
    else if (this.message && this.message.until > Date.now()) right = this.message;
    else if (this.overlaps.length) {
      const o = this.overlaps[0]!;
      right = {
        text: `!! ${o.file}: ${o.sessions.join(' + ')}${this.overlaps.length > 1 ? ` (+${this.overlaps.length - 1})` : ''}`,
        style: STYLE.warn,
      };
    } else {
      const total = [...this.costs.values()].reduce((s, c) => s + c.usd, 0);
      right = {
        text: `${total ? `$${total.toFixed(2)} est · ` : ''}ctrl+\\ ? help`,
        style: STYLE.status,
      };
    }
    const room = r.w - x - 2;
    if (room > 4) {
      const t = ` ${truncate(right.text, room - 2)} `;
      screen.text(r.w - textWidth(t), r.y, t, right.style);
    }
  }

  private drawOverlay(screen: Screen): void {
    const o = this.overlay!;
    const body = o.kind === 'pick' ? o.items.map((it, i) => `${i + 1}  ${it.label}`) : o.lines;
    const footer =
      o.kind === 'confirm'
        ? 'y yes · n no'
        : o.kind === 'pick'
          ? '1-9 pick · esc cancel'
          : 'any key to close';
    const width = Math.min(
      this.cols - 4,
      Math.max(textWidth(o.title) + 4, ...body.map((l) => textWidth(l) + 4), 44),
    );
    const height = Math.min(this.rows - 3, body.length + 4);
    const x0 = Math.floor((this.cols - width) / 2);
    const y0 = Math.max(0, Math.floor((this.rows - 1 - height) / 2));
    screen.fill({ x: x0, y: y0, w: width, h: height }, ' ', STYLE.overlay);
    screen.text(x0 + 2, y0, ` ${o.title} `, STYLE.overlayTitle, width - 4);
    body
      .slice(0, height - 4)
      .forEach((line, i) =>
        screen.text(x0 + 2, y0 + 2 + i, truncate(line, width - 4), STYLE.overlay),
      );
    screen.text(x0 + 2, y0 + height - 1, footer, STYLE.overlayTitle, width - 4);
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
