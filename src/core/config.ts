import crypto from 'node:crypto';
import path from 'node:path';
import { pitstopHome } from './paths.js';
import { readJson, writeJsonAtomic } from './store.js';

export type PermissionMode =
  'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

/** A one-key fork recipe, e.g. "hotfix". */
export interface Preset {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** Stop the fork when its estimated spend passes this many dollars. */
  budgetUsd?: number;
  /** Require the test command to pass before merging. */
  testGate?: boolean;
  /** Run the fork as a Claude cloud session instead of on this machine. */
  cloud?: boolean;
  /** Run the fork with another coding agent (a key of `agents`) instead of Claude. */
  agent?: string;
}

/** Another coding agent pitstop can host in a pane (e.g. Codex, Gemini CLI). */
export interface AgentConfig {
  cmd: string;
  /** Arguments before the prompt, which is always passed last. */
  args?: string[];
  /** Arguments that reopen the agent's latest session in the same directory. */
  resumeArgs?: string[];
  /** Who receives the conversation summary, shown in the privacy prompt. */
  provider?: string;
}

export interface SetupConfig {
  /** Files copied from the main checkout into each fork (e.g. ".env"). */
  copy?: string[];
  /** Paths symlinked from the main checkout (e.g. "node_modules"). */
  symlink?: string[];
  /** Shell command run in the fork's worktree after it is created. */
  run?: string;
}

export interface PitConfig {
  /** Prefix key that pitstop takes from the terminal, e.g. "ctrl+\\". */
  prefixKey: string;
  /** Most live sessions (main + forks) pitstop will run at once. */
  maxSessions: number;
  /** Fork panes shown beside main before extra forks become tabs. */
  visibleForks: number;
  /** Terminal width at which panes go side by side instead of stacked. */
  splitColumns: number;
  /** Test command for the merge gate, run in the fork's worktree. */
  test?: string;
  /** Run the test gate on every merge, not just presets that ask for it. */
  testGate: boolean;
  merge: { mode: 'local' | 'pr' };
  setup: SetupConfig;
  presets: Record<string, Preset>;
  agents: Record<string, AgentConfig>;
  radarIntervalMs: number;
  /** Port offset step per fork slot, exported as PITSTOP_PORT_OFFSET. */
  portStep: number;
  /** One-step shortcuts: F1-F9 and macOS Option+letter (⌥F fork, ⌥M merge, …). */
  shortKeys: boolean;
  /** Install new pitstop versions automatically in the background (user config only). */
  autoUpgrade: boolean;
}

export const DEFAULT_CONFIG: PitConfig = {
  prefixKey: 'ctrl+\\',
  maxSessions: 6,
  visibleForks: 3,
  splitColumns: 160,
  testGate: false,
  merge: { mode: 'local' },
  setup: {},
  presets: {
    hotfix: { permissionMode: 'acceptEdits', effort: 'medium', testGate: true },
    explore: { permissionMode: 'plan' },
    cloud: { cloud: true },
    codex: { agent: 'codex' },
    gemini: { agent: 'gemini' },
  },
  agents: {
    codex: { cmd: 'codex', args: [], resumeArgs: ['resume', '--last'], provider: 'OpenAI' },
    gemini: { cmd: 'gemini', args: ['-i'], resumeArgs: ['--resume', 'latest'], provider: 'Google' },
  },
  radarIntervalMs: 5000,
  portStep: 100,
  shortKeys: true,
  autoUpgrade: true,
};

export type PartialConfig = Partial<Omit<PitConfig, 'merge' | 'setup'>> & {
  merge?: Partial<PitConfig['merge']>;
  setup?: SetupConfig;
};

export function mergeConfig(base: PitConfig, over: PartialConfig | undefined): PitConfig {
  if (!over) return base;
  return {
    ...base,
    ...over,
    merge: { ...base.merge, ...over.merge },
    setup: { ...base.setup, ...over.setup },
    presets: { ...base.presets, ...over.presets },
    agents: { ...base.agents, ...over.agents },
  };
}

/**
 * The only permission modes a repository's own .pitstop.json may set. Anything
 * else (bypassPermissions, dontAsk, auto, unknown values) must come from the
 * user's ~/.pitstop/config.json.
 */
const REPO_ALLOWED_MODES: string[] = ['plan', 'manual', 'acceptEdits'];

export interface RepoCommands {
  test?: string;
  setupRun?: string;
  /** Agent commands the repo defines or redefines. */
  agents?: Record<string, AgentConfig>;
}

/** The commands a repo's .pitstop.json asks pitstop to run. */
export function repoCommands(repoCfg: PartialConfig | undefined): RepoCommands {
  const agents = repoCfg?.agents && Object.keys(repoCfg.agents).length ? repoCfg.agents : undefined;
  return { test: repoCfg?.test, setupRun: repoCfg?.setup?.run, agents };
}

function hasCommands(cmds: RepoCommands): boolean {
  return !!(cmds.test || cmds.setupRun || cmds.agents);
}

function commandsHash(cmds: RepoCommands): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([cmds.test ?? null, cmds.setupRun ?? null, cmds.agents ?? null]))
    .digest('hex');
}

function trustFile(repoTop: string): string {
  return path.join(
    pitstopHome(),
    'trusted',
    `${crypto.createHash('sha1').update(repoTop).digest('hex').slice(0, 16)}.json`,
  );
}

/** True when the user approved exactly these repo commands with `pit trust`. */
export function repoCommandsTrusted(repoTop: string, cmds: RepoCommands): boolean {
  if (!hasCommands(cmds)) return true;
  return readJson<{ hash: string }>(trustFile(repoTop))?.hash === commandsHash(cmds);
}

export function trustRepoCommands(repoTop: string, cmds: RepoCommands): void {
  writeJsonAtomic(trustFile(repoTop), {
    repoTop,
    hash: commandsHash(cmds),
    ...cmds,
    trustedAt: new Date().toISOString(),
  });
}

export function readRepoConfig(repoTop: string): PartialConfig | undefined {
  return readJson<PartialConfig>(path.join(repoTop, '.pitstop.json'));
}

/**
 * Strip what a cloned repository must not be able to do on its own: run
 * commands the user hasn't approved, or hand forks elevated permissions.
 */
export function sanitizeRepoConfig(
  repoCfg: PartialConfig,
  trusted: boolean,
): { cfg: PartialConfig; dropped: string[] } {
  const dropped: string[] = [];
  const cfg: PartialConfig = { ...repoCfg, setup: { ...repoCfg.setup } };
  // How pitstop updates itself is the user's call, not a repo's.
  delete cfg.autoUpgrade;
  if (!trusted) {
    if (cfg.test) dropped.push(`test command "${cfg.test}"`);
    if (cfg.setup?.run) dropped.push(`setup command "${cfg.setup.run}"`);
    if (cfg.agents && Object.keys(cfg.agents).length) {
      dropped.push(`agent commands for ${Object.keys(cfg.agents).join(', ')}`);
    }
    delete cfg.test;
    delete cfg.agents;
    if (cfg.setup) delete cfg.setup.run;
  }
  if (cfg.presets) {
    const presets: Record<string, Preset> = {};
    for (const [name, p] of Object.entries(cfg.presets)) {
      if (p.permissionMode && !REPO_ALLOWED_MODES.includes(p.permissionMode)) {
        dropped.push(`permissionMode "${p.permissionMode}" in preset "${name}"`);
        presets[name] = { ...p, permissionMode: undefined };
      } else presets[name] = p;
    }
    cfg.presets = presets;
  }
  return { cfg, dropped };
}

/**
 * Defaults, then ~/.pitstop/config.json, then <repo>/.pitstop.json. The repo
 * layer is sanitized: its commands need `pit trust`, and it can't grant
 * elevated permission modes.
 */
export function loadConfig(repoTop?: string): PitConfig & { untrusted?: string[] } {
  let cfg = mergeConfig(
    DEFAULT_CONFIG,
    readJson<PartialConfig>(path.join(pitstopHome(), 'config.json')),
  );
  if (!repoTop) return cfg;
  const repoCfg = readRepoConfig(repoTop);
  if (!repoCfg) return cfg;
  const { cfg: safe, dropped } = sanitizeRepoConfig(
    repoCfg,
    repoCommandsTrusted(repoTop, repoCommands(repoCfg)),
  );
  cfg = mergeConfig(cfg, safe);
  return dropped.length ? { ...cfg, untrusted: dropped } : cfg;
}

/** Map a prefix like "ctrl+\\" or "ctrl+a" to the single byte the terminal sends. */
export function prefixByte(key: string): number {
  const m = /^ctrl\+(.)$/i.exec(key.trim());
  if (!m || !m[1]) throw new Error(`Unsupported prefix key "${key}". Use ctrl+<key>, e.g. ctrl+\\`);
  const ch = m[1].toLowerCase();
  if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 96;
  const special: Record<string, number> = { '\\': 0x1c, ']': 0x1d, '^': 0x1e, _: 0x1f, '@': 0x00 };
  const byte = special[ch];
  if (byte === undefined) throw new Error(`Unsupported prefix key "${key}"`);
  return byte;
}

/** What a preset runs on: this machine with Claude, a Claude cloud session, or another agent. */
export function presetKind(p: Preset | undefined): 'claude' | 'cloud' | 'agent' {
  if (p?.cloud) return 'cloud';
  if (p?.agent) return 'agent';
  return 'claude';
}

/** "hotfix: fix the login" → preset hotfix. Unknown prefixes stay part of the task. */
export function parseTaskInput(
  input: string,
  presets: Record<string, Preset>,
): { task: string; preset?: string } {
  const m = /^\s*([a-z0-9_-]+)\s*:\s*(.+)$/is.exec(input);
  if (m && m[1] && m[2] && presets[m[1].toLowerCase()]) {
    return { preset: m[1].toLowerCase(), task: m[2].trim() };
  }
  return { task: input.trim() };
}
