import path from 'node:path';
import { pitstopHome } from './paths.js';
import { readJson } from './store.js';

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

/** A one-key fork recipe, e.g. "hotfix". */
export interface Preset {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  /** Stop the fork when its estimated spend passes this many dollars. */
  budgetUsd?: number;
  /** Require the test command to pass before merging. */
  testGate?: boolean;
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
  radarIntervalMs: number;
  /** Port offset step per fork slot, exported as PITSTOP_PORT_OFFSET. */
  portStep: number;
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
  },
  radarIntervalMs: 5000,
  portStep: 100,
};

type PartialConfig = Partial<Omit<PitConfig, 'merge' | 'setup'>> & {
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
  };
}

/** Defaults, then ~/.pitstop/config.json, then <repo>/.pitstop.json. */
export function loadConfig(repoTop?: string): PitConfig {
  let cfg = mergeConfig(DEFAULT_CONFIG, readJson<PartialConfig>(path.join(pitstopHome(), 'config.json')));
  if (repoTop) cfg = mergeConfig(cfg, readJson<PartialConfig>(path.join(repoTop, '.pitstop.json')));
  return cfg;
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

/** "hotfix: fix the login" → preset hotfix. Unknown prefixes stay part of the task. */
export function parseTaskInput(input: string, presets: Record<string, Preset>): { task: string; preset?: string } {
  const m = /^\s*([a-z0-9_-]+)\s*:\s*(.+)$/is.exec(input);
  if (m && m[1] && m[2] && presets[m[1].toLowerCase()]) {
    return { preset: m[1].toLowerCase(), task: m[2].trim() };
  }
  return { task: input.trim() };
}
