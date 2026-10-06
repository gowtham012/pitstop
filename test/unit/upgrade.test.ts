import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  installKind,
  isNewer,
  loadState,
  shouldCheck,
  takeNotice,
  upgrade,
  upgradeNpm,
  type UpgradeDeps,
} from '../../src/upgrade.js';
import { VERSION } from '../../src/version.js';
import { commit, isolate, read, sh, tmpDir, write } from '../helpers.js';

let env: ReturnType<typeof isolate>;
let origin: string;
let install: string;
let calls: string[];

/** A clone with a built dist/ that tracks origin/main, like `git clone` + `npm install -g .`. */
function setup() {
  const seed = tmpDir('pitstop-seed-');
  sh('git', ['init', '-q', '-b', 'main'], seed);
  write(seed, 'package.json', JSON.stringify({ name: 'pitstop-cli', version: '0.1.0' }));
  write(seed, 'package-lock.json', '{}\n');
  write(seed, '.gitignore', 'dist/\n.dist-next/\n.dist-old/\n');
  write(seed, 'src.txt', 'v1\n');
  commit(seed, 'v1');
  origin = tmpDir('pitstop-origin-');
  sh('git', ['clone', '-q', '--bare', seed, origin], seed);
  install = path.join(tmpDir('pitstop-install-'), 'pitstop');
  sh('git', ['clone', '-q', origin, install], seed);
  write(install, 'dist/cli.js', 'old build\n');
  return seed;
}

/** Push a new upstream commit from a second clone. */
function publish(files: Record<string, string>, message = 'next') {
  const dev = path.join(tmpDir('pitstop-dev-'), 'dev');
  sh('git', ['clone', '-q', origin, dev], origin);
  for (const [f, c] of Object.entries(files)) write(dev, f, c);
  commit(dev, message);
  sh('git', ['push', '-q', 'origin', 'main'], dev);
}

function deps(over: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    install: (root) => {
      calls.push('install');
      write(root, 'dist/cli.js', 'installed build\n');
      return { code: 0, stdout: '', stderr: '' };
    },
    build: (_root, outDir) => {
      calls.push('build');
      write(outDir, 'cli.js', 'new build\n');
      return { code: 0, stdout: '', stderr: '' };
    },
    npmLatest: () => undefined,
    npmInstall: () => ({ code: 1, stdout: '', stderr: 'unused' }),
    ...over,
  };
}

beforeEach(() => {
  env = isolate();
  calls = [];
  setup();
});
afterEach(() => env.restore());

describe('upgrade from a source install', () => {
  it('says so when there is nothing new', () => {
    const r = upgrade({ root: install, deps: deps() });
    expect(r.status).toBe('up-to-date');
    expect(calls).toEqual([]);
    expect(loadState().checkedAt).toBeTruthy();
  });

  it('fast-forwards, builds beside dist/ and swaps it in', () => {
    publish({ 'src.txt': 'v2\n', 'package.json': JSON.stringify({ version: '0.2.0' }) });
    // package.json changed, so dependencies are reinstalled
    let r = upgrade({ root: install, deps: deps() });
    expect(r.status).toBe('upgraded');
    expect(calls).toEqual(['install']);
    expect(read(install, 'src.txt')).toBe('v2\n');
    expect(r).toMatchObject({
      from: expect.stringMatching(/^0\.1\.0 /),
      to: expect.stringMatching(/^0\.2\.0 /),
    });

    publish({ 'src.txt': 'v3\n' });
    calls = [];
    r = upgrade({ root: install, deps: deps() });
    expect(r.status).toBe('upgraded');
    expect(calls).toEqual(['build']);
    expect(read(install, 'dist/cli.js')).toBe('new build\n');
    expect(fs.existsSync(path.join(install, '.dist-next'))).toBe(false);
    expect(fs.existsSync(path.join(install, '.dist-old'))).toBe(false);
    expect(sh('git', ['status', '--porcelain'], install)).toBe('');
  });

  it('never touches uncommitted changes or local commits', () => {
    publish({ 'src.txt': 'v2\n' });
    write(install, 'src.txt', 'my local fix\n');
    const head = sh('git', ['rev-parse', 'HEAD'], install);
    let r = upgrade({ root: install, deps: deps() });
    expect(r).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/uncommitted changes/),
    });
    expect(read(install, 'src.txt')).toBe('my local fix\n');
    expect(sh('git', ['rev-parse', 'HEAD'], install)).toBe(head);

    commit(install, 'local');
    r = upgrade({ root: install, deps: deps() });
    expect(r).toMatchObject({ status: 'blocked', reason: expect.stringMatching(/local commits/) });
    expect(calls).toEqual([]);
    expect(loadState().blocked?.reason).toMatch(/local commits/);
  });

  it('goes back to the old version when the build fails', () => {
    publish({ 'src.txt': 'v2\n' });
    const head = sh('git', ['rev-parse', 'HEAD'], install);
    const r = upgrade({
      root: install,
      deps: deps({ build: () => ({ code: 1, stdout: '', stderr: 'tsc exploded' }) }),
    });
    expect(r).toMatchObject({ status: 'failed', reason: expect.stringMatching(/tsc exploded/) });
    expect(sh('git', ['rev-parse', 'HEAD'], install)).toBe(head);
    expect(read(install, 'dist/cli.js')).toBe('old build\n');
    expect(loadState().error).toMatch(/tsc exploded/);
  });

  it('only checks with checkOnly', () => {
    publish({ 'src.txt': 'v2\n' });
    const r = upgrade({ root: install, checkOnly: true, deps: deps() });
    expect(r.status).toBe('available');
    expect(read(install, 'src.txt')).toBe('v1\n');
  });

  it('skips a clone that tracks no remote branch', () => {
    sh('git', ['checkout', '-q', '-b', 'local-only'], install);
    expect(upgrade({ root: install, deps: deps() }).status).toBe('skipped');
  });
});

describe('upgrade from npm', () => {
  it('installs a newer published version only', () => {
    const installs: string[] = [];
    const d = (latest: string) =>
      deps({
        npmLatest: () => latest,
        npmInstall: (v) => {
          installs.push(v);
          return { code: 0, stdout: '', stderr: '' };
        },
      });
    expect(upgradeNpm({ deps: d(VERSION) }).status).toBe('up-to-date');
    expect(upgradeNpm({ deps: d('99.0.0') })).toEqual({
      status: 'upgraded',
      from: VERSION,
      to: '99.0.0',
    });
    expect(installs).toEqual(['99.0.0']);
  });

  it('compares versions numerically', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('garbage', '0.1.0')).toBe(false);
  });

  it('knows how it was installed', () => {
    expect(installKind(install)).toBe('source');
    expect(installKind(path.join(env.home, 'lib', 'node_modules', 'pitstop-cli'))).toBe('npm');
  });
});

describe('background checks', () => {
  it('runs at most once a day, never in CI or when turned off', () => {
    const now = Date.now();
    const clean = {};
    expect(shouldCheck({}, true, now, clean)).toBe(true);
    expect(shouldCheck({ checkedAt: new Date(now - 1000).toISOString() }, true, now, clean)).toBe(
      false,
    );
    expect(
      shouldCheck(
        { checkedAt: new Date(now - CHECK_INTERVAL_MS - 1).toISOString() },
        true,
        now,
        clean,
      ),
    ).toBe(true);
    expect(shouldCheck({}, false, now, clean)).toBe(false);
    expect(shouldCheck({}, true, now, { CI: 'true' })).toBe(false);
    expect(shouldCheck({}, true, now, { PITSTOP_NO_UPDATE: '1' })).toBe(false);
  });

  it('tells the user once what it installed', () => {
    publish({ 'src.txt': 'v2\n' });
    upgrade({ root: install, deps: deps() });
    expect(takeNotice()).toMatch(/^pitstop updated: 0\.1\.0 \(\w+\) → 0\.1\.0 \(\w+\)$/);
    expect(takeNotice()).toBeUndefined();
  });
});
