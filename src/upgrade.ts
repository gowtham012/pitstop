import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSync, type RunResult } from './core/exec.js';
import { git } from './core/git.js';
import { logsDir, pitstopHome } from './core/paths.js';
import { readJson, writeJsonAtomic } from './core/store.js';
import { VERSION } from './version.js';

/** How often the background check runs at most. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const NPM_PACKAGE = 'pitstop-cli';

export type InstallKind = 'source' | 'npm' | 'unknown';

export interface UpgradeState {
  checkedAt?: string;
  /** Last install pitstop did by itself, shown once on the next start. */
  installed?: { from: string; to: string; at: string; seen?: boolean };
  /** A newer version exists but couldn't be installed automatically. */
  blocked?: { reason: string; at: string; seen?: boolean };
  error?: string;
}

export type UpgradeOutcome =
  | { status: 'up-to-date'; current: string }
  | { status: 'upgraded'; from: string; to: string }
  | { status: 'available'; current: string; latest: string }
  | { status: 'blocked'; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export interface UpgradeDeps {
  /** Reinstall dependencies (only when package.json or the lockfile changed). */
  install: (root: string) => RunResult;
  /** Build into `outDir` without touching the live dist/. */
  build: (root: string, outDir: string) => RunResult;
  /** Latest published version on npm. */
  npmLatest: () => string | undefined;
  /** Install a published version globally. */
  npmInstall: (version: string) => RunResult;
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
/** Published installs always come from the public registry, never one a repo's .npmrc names. */
const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** A folder no repository controls, so no project .npmrc is read. */
const neutralDir = (): string => {
  fs.mkdirSync(pitstopHome(), { recursive: true });
  return pitstopHome();
};

export const defaultDeps: UpgradeDeps = {
  install: (root) =>
    runSync(npmBin, ['ci', '--no-audit', '--no-fund'], { cwd: root, timeoutMs: 600_000 }),
  build: (root, outDir) =>
    runSync(
      process.execPath,
      [path.join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js'), '--out-dir', outDir],
      {
        cwd: root,
        timeoutMs: 300_000,
      },
    ),
  npmLatest: () => {
    const r = runSync(npmBin, ['view', NPM_PACKAGE, 'version', '--registry', NPM_REGISTRY], {
      cwd: neutralDir(),
      timeoutMs: 30_000,
    });
    return r.code === 0 ? r.stdout.trim() || undefined : undefined;
  },
  npmInstall: (version) =>
    runSync(
      npmBin,
      [
        'install',
        '-g',
        `${NPM_PACKAGE}@${version}`,
        '--registry',
        NPM_REGISTRY,
        '--no-audit',
        '--no-fund',
      ],
      { cwd: neutralDir(), timeoutMs: 600_000 },
    ),
};

/** pitstop's own install folder (the npm global link is followed to the real folder). */
export function packageRoot(): string {
  const here = fs.realpathSync(fileURLToPath(import.meta.url));
  // dist/cli.js when built, src/upgrade.ts in tests: either way the root is one level up.
  return path.resolve(path.dirname(here), '..');
}

export function installKind(root: string): InstallKind {
  if (fs.existsSync(path.join(root, '.git'))) return 'source';
  if (root.split(path.sep).includes('node_modules')) return 'npm';
  return 'unknown';
}

export function stateFile(): string {
  return path.join(pitstopHome(), 'upgrade.json');
}

export function loadState(): UpgradeState {
  return readJson<UpgradeState>(stateFile()) ?? {};
}

export function saveState(patch: Partial<UpgradeState>): UpgradeState {
  const next = { ...loadState(), ...patch };
  writeJsonAtomic(stateFile(), next);
  return next;
}

/** True when automatic upgrades are on and the last check is old enough. */
export function shouldCheck(
  state: UpgradeState,
  enabled: boolean,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!enabled || env.PITSTOP_NO_UPDATE || env.CI) return false;
  const last = state.checkedAt ? Date.parse(state.checkedAt) : 0;
  return !(now - last < CHECK_INTERVAL_MS);
}

function describe(root: string, rev: string): string {
  const sha = git(['rev-parse', '--short', rev], root).stdout.trim();
  const version = git(['show', `${rev}:package.json`], root).stdout;
  let v = '';
  try {
    v = (JSON.parse(version) as { version?: string }).version ?? '';
  } catch {
    // no package.json at that commit
  }
  return v ? `${v} (${sha})` : sha;
}

/** Newer than `a`? Plain x.y.z comparison; anything unparsable is treated as not newer. */
export function isNewer(b: string, a: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length < 3 || pb.length < 3 || [...pa, ...pb].some((n) => Number.isNaN(n))) return false;
  for (let i = 0; i < 3; i++) if (pb[i]! !== pa[i]!) return pb[i]! > pa[i]!;
  return false;
}

/**
 * Bring a source install (a git clone) up to date with the branch it tracks.
 * Never touches local work: uncommitted changes or local commits block the upgrade.
 * The new build is made beside dist/ and swapped in, so running sessions keep working.
 */
export function upgradeSource(
  root: string,
  opts: { checkOnly?: boolean; deps?: UpgradeDeps } = {},
): UpgradeOutcome {
  const deps = opts.deps ?? defaultDeps;
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  if (upstream.code !== 0)
    return { status: 'skipped', reason: `${root} doesn't track a remote branch` };
  const remote = upstream.stdout.trim().split('/')[0]!;
  const fetch = git(['fetch', '--quiet', remote], root);
  if (fetch.code !== 0)
    return { status: 'failed', reason: `git fetch failed: ${fetch.stderr.trim().split('\n')[0]}` };
  const count = (range: string) =>
    Number(git(['rev-list', '--count', range], root).stdout.trim() || '0');
  const behind = count('HEAD..@{u}');
  const old = git(['rev-parse', 'HEAD'], root).stdout.trim();
  if (behind === 0) return { status: 'up-to-date', current: describe(root, 'HEAD') };
  const latest = describe(root, '@{u}');
  if (opts.checkOnly) return { status: 'available', current: describe(root, 'HEAD'), latest };
  if (count('@{u}..HEAD') > 0)
    return {
      status: 'blocked',
      reason: `${root} has local commits that aren't on ${upstream.stdout.trim()}`,
    };
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], root).stdout.trim();
  if (dirty) return { status: 'blocked', reason: `${root} has uncommitted changes` };

  const from = describe(root, 'HEAD');
  const ff = git(['merge', '--ff-only', '--quiet', '@{u}'], root);
  if (ff.code !== 0) return { status: 'failed', reason: `git merge failed: ${ff.stderr.trim()}` };
  const rollback = (reason: string): UpgradeOutcome => {
    git(['reset', '--keep', old], root);
    return { status: 'failed', reason };
  };

  const depsChanged =
    git(['diff', '--quiet', old, 'HEAD', '--', 'package.json', 'package-lock.json'], root).code !==
    0;
  if (depsChanged) {
    // npm ci also runs the build (prepare); dependencies change rarely.
    const inst = deps.install(root);
    if (inst.code !== 0) {
      const res = rollback(`npm ci failed: ${lastLine(inst)}`);
      deps.install(root); // put the old dependencies back
      return res;
    }
  } else {
    const next = path.join(root, '.dist-next');
    const prev = path.join(root, '.dist-old');
    fs.rmSync(next, { recursive: true, force: true });
    const build = deps.build(root, next);
    if (build.code !== 0 || !fs.existsSync(path.join(next, 'cli.js'))) {
      fs.rmSync(next, { recursive: true, force: true });
      return rollback(`build failed: ${lastLine(build)}`);
    }
    const dist = path.join(root, 'dist');
    fs.rmSync(prev, { recursive: true, force: true });
    if (fs.existsSync(dist)) fs.renameSync(dist, prev);
    fs.renameSync(next, dist);
    fs.rmSync(prev, { recursive: true, force: true });
  }
  return { status: 'upgraded', from, to: describe(root, 'HEAD') };
}

export function upgradeNpm(opts: { checkOnly?: boolean; deps?: UpgradeDeps } = {}): UpgradeOutcome {
  const deps = opts.deps ?? defaultDeps;
  const latest = deps.npmLatest();
  if (!latest) return { status: 'failed', reason: `couldn't reach npm to look up ${NPM_PACKAGE}` };
  if (!isNewer(latest, VERSION)) return { status: 'up-to-date', current: VERSION };
  if (opts.checkOnly) return { status: 'available', current: VERSION, latest };
  const r = deps.npmInstall(latest);
  if (r.code !== 0) return { status: 'failed', reason: `npm install failed: ${lastLine(r)}` };
  return { status: 'upgraded', from: VERSION, to: latest };
}

function lastLine(r: RunResult): string {
  const lines = `${r.stderr}\n${r.stdout}`.trim().split('\n');
  return lines.at(-1)?.trim() ?? `exit ${r.code}`;
}

/** Check (and unless `checkOnly`, install) the newest version, and remember what happened. */
export function upgrade(
  opts: { checkOnly?: boolean; root?: string; deps?: UpgradeDeps } = {},
): UpgradeOutcome {
  const root = opts.root ?? packageRoot();
  const kind = installKind(root);
  const outcome =
    kind === 'source'
      ? upgradeSource(root, opts)
      : kind === 'npm'
        ? upgradeNpm(opts)
        : ({ status: 'skipped', reason: `don't know how ${root} was installed` } as const);
  const at = new Date().toISOString();
  const patch: Partial<UpgradeState> = { checkedAt: at, error: undefined };
  if (outcome.status === 'upgraded') {
    patch.installed = { from: outcome.from, to: outcome.to, at };
    patch.blocked = undefined;
  } else if (outcome.status === 'blocked') patch.blocked = { reason: outcome.reason, at };
  else if (outcome.status === 'up-to-date') patch.blocked = undefined;
  else if (outcome.status === 'failed') patch.error = outcome.reason;
  if (!opts.checkOnly) saveState(patch);
  return outcome;
}

/** Start a background `pit upgrade --auto` if it's due. Never blocks or throws. */
export function startBackgroundUpgrade(enabled: boolean, cliPath = process.argv[1]): boolean {
  try {
    if (!cliPath || !shouldCheck(loadState(), enabled)) return false;
    saveState({ checkedAt: new Date().toISOString() }); // one attempt per interval, even if it dies
    fs.mkdirSync(logsDir(), { recursive: true });
    const log = fs.openSync(path.join(logsDir(), 'upgrade.log'), 'a');
    // Run from pitstop's own folder, not the user's repo, so nothing in the repo can steer it.
    const child = spawn(process.execPath, [cliPath, 'upgrade', '--auto'], {
      cwd: packageRoot(),
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
    fs.closeSync(log);
    return true;
  } catch {
    return false;
  }
}

/** One-line notice about the last automatic upgrade, if the user hasn't seen it yet. */
export function takeNotice(): string | undefined {
  const s = loadState();
  if (s.installed && !s.installed.seen) {
    saveState({ installed: { ...s.installed, seen: true } });
    return `pitstop updated: ${s.installed.from} → ${s.installed.to}`;
  }
  if (s.blocked && !s.blocked.seen) {
    saveState({ blocked: { ...s.blocked, seen: true } });
    return `a pitstop update is available, but ${s.blocked.reason}; run \`pit upgrade\` after committing`;
  }
  return undefined;
}
