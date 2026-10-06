import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'fake-claude.mjs');

export function tmpDir(prefix = 'pitstop-test-'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A git repo with one commit containing the given files. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# demo\n' }): string {
  const dir = tmpDir('pitstop-repo-');
  sh('git', ['init', '-q', '-b', 'main'], dir);
  sh('git', ['config', 'user.name', 'Test'], dir);
  sh('git', ['config', 'user.email', 'test@example.com'], dir);
  for (const [f, c] of Object.entries(files)) write(dir, f, c);
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

export function write(dir: string, file: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), contents);
}

export function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

export function commit(dir: string, message: string): void {
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-q', '-m', message], dir);
}

/** Point pitstop and the fake claude at fresh temp state. Returns a restore function. */
export function isolate(): { home: string; fakeState: string; restore: () => void } {
  const prev = {
    PITSTOP_HOME: process.env.PITSTOP_HOME,
    PITSTOP_CLAUDE_BIN: process.env.PITSTOP_CLAUDE_BIN,
    FAKE_CLAUDE_STATE: process.env.FAKE_CLAUDE_STATE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    PITSTOP_HOOK_CMD: process.env.PITSTOP_HOOK_CMD,
  };
  const home = tmpDir('pitstop-home-');
  const fakeState = tmpDir('pitstop-fake-');
  fs.chmodSync(FAKE_CLAUDE, 0o755);
  process.env.PITSTOP_HOME = home;
  process.env.PITSTOP_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_STATE = fakeState;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude-config');
  process.env.PITSTOP_HOOK_CMD = 'pitstop-hook';
  return {
    home,
    fakeState,
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

export function fakeAgents(fakeState: string): Record<string, unknown>[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(fakeState, 'agents.json'), 'utf8')) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export function setFakeAgents(fakeState: string, agents: Record<string, unknown>[]): void {
  fs.writeFileSync(path.join(fakeState, 'agents.json'), JSON.stringify(agents));
}

export function fakeCalls(fakeState: string): { argv: string[]; cwd: string }[] {
  try {
    return fs
      .readFileSync(path.join(fakeState, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
  } catch {
    return [];
  }
}
