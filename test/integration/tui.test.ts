import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listBranches } from '../../src/branches.js';
import { repoContext } from '../../src/core/git.js';
import { handleHook } from '../../src/hook/entry.js';
import { fakeAgents, fakeCalls, isolate, makeRepo, write, commit, sh, tmpDir } from '../helpers.js';

const FAKE_AGENT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../bin/fake-agent.mjs',
);

const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli.js');
const PREFIX = '\x1c';

interface Driver {
  screen: () => string;
  send: (s: string) => void;
  waitFor: (re: RegExp, ms?: number) => Promise<string>;
  exited: () => boolean;
  kill: () => void;
}

function drive(cwd: string, cols = 180, rows = 40): Driver {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  let exited = false;
  const p = pty.spawn(process.execPath, [CLI], {
    cwd,
    cols,
    rows,
    env: process.env as Record<string, string>,
    name: 'xterm-256color',
  });
  p.onData((d) => term.write(d));
  p.onExit(() => (exited = true));
  const screen = () => {
    const b = term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < term.rows; i++)
      out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return out.join('\n');
  };
  return {
    screen,
    send: (s) => p.write(s),
    exited: () => exited,
    kill: () => {
      if (!exited) p.kill();
    },
    waitFor: async (re, ms = 15000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const s = screen();
        if (re.test(s)) return s;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${re}\n----\n${screen()}`);
    },
  };
}

let env: ReturnType<typeof isolate>;
let repo: string;
let d: Driver | undefined;

beforeEach(() => {
  env = isolate();
  delete process.env.PITSTOP_HOOK_CMD;
  repo = makeRepo({ 'app.py': 'print(1)\n' });
});
afterEach(() => {
  d?.kill();
  env.restore();
});

describe('pit split-pane UI', () => {
  it('starts main, forks into a split pane with the hotkey, and quits leaving sessions running', async () => {
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    await d.waitFor(/1 ● main|1 · main/);
    expect(fakeAgents(env.fakeState)).toHaveLength(1);

    d.send(PREFIX);
    d.send('f');
    await d.waitFor(/fork of main · no preset \(Tab\) · task/);
    d.send('fix the login\r');
    await d.waitFor(/fix-the-login/);
    const s = await d.waitFor(/fork of main[\s\S]*fake claude session[\s\S]*fake claude session/);
    expect(s).toMatch(/2 . fix-the-login/);
    expect(fakeAgents(env.fakeState)).toHaveLength(2);
    const forkCall = fakeCalls(env.fakeState).find((c) => c.argv.includes('--fork-session'));
    expect(forkCall).toBeTruthy();

    // keys typed go to the focused (fork) pane
    d.send('hello');
    await d.waitFor(/❯ hello/);

    // zoom, then back
    d.send(`${PREFIX}z`);
    await d.waitFor(/main ·|1 main/);
    d.send(`${PREFIX}z`);

    d.send(`${PREFIX}t`);
    await d.waitFor(/branch tree/);
    d.send('x');

    d.send(`${PREFIX}q`);
    await d.waitFor(/Quit pit\?/);
    d.send('y');
    const start = Date.now();
    while (!d.exited() && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 100));
    expect(d.exited()).toBe(true);
    // sessions are still there for next time
    expect(fakeAgents(env.fakeState)).toHaveLength(2);
  });

  it('reopens the same panes on restart', async () => {
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    d.send(`${PREFIX}f`);
    await d.waitFor(/task/);
    d.send('restore me\r');
    await d.waitFor(/restore-me/);
    d.send(`${PREFIX}q`);
    await d.waitFor(/Quit pit\?/);
    d.send('y');
    await new Promise((r) => setTimeout(r, 800));
    d.kill();

    d = drive(repo);
    const s = await d.waitFor(
      /restore-me[\s\S]*fake claude session|fake claude session[\s\S]*restore-me/,
    );
    expect(s).toContain('main');
    // reused the same main session instead of starting another
    expect(fakeAgents(env.fakeState)).toHaveLength(2);
  });

  it('warns that untrusted repo commands are ignored', async () => {
    write(repo, '.pitstop.json', JSON.stringify({ test: 'npm test' }));
    commit(repo, 'cfg');
    d = drive(repo);
    await d.waitFor(/pit trust/);
  });

  it('cycles presets with Tab in the fork prompt', async () => {
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    d.send(`${PREFIX}f`);
    await d.waitFor(/no preset \(Tab\)/);
    d.send('\t');
    await d.waitFor(/preset: hotfix \(Tab\)/);
    d.send('\t');
    await d.waitFor(/preset: explore \(Tab\)/);
    d.send('\x1b');
  });

  it("opens a fork's diff in a pane and closes it with q", async () => {
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    d.send(`${PREFIX}f`);
    await d.waitFor(/task/);
    d.send('diff me\r');
    await d.waitFor(/2 . diff-me/);
    const repoId = repoContext(repo).repoId;
    const b = listBranches(repoId).find((x) => x.name === 'diff-me')!;
    const wt = handleHook('WorktreeCreate', {
      session_id: b.sessionId!,
      cwd: repo,
      name: 'x',
    }).stdout!;
    write(wt, 'feature.txt', 'a new feature\n');
    commit(wt, 'feature');
    d.send(`${PREFIX}d`);
    await d.waitFor(/diff diff-me \(q to close\)/);
    await d.waitFor(/feature\.txt/);
    d.send('q');
    const start = Date.now();
    while (/diff diff-me \(q to close\)/.test(d.screen()) && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(d.screen()).not.toMatch(/diff diff-me \(q to close\)/);
  });

  it('forks into another agent after asking once, in a pane in its own worktree', async () => {
    fs.mkdirSync(env.home, { recursive: true });
    fs.writeFileSync(
      path.join(env.home, 'config.json'),
      JSON.stringify({
        agents: {
          codex: {
            cmd: FAKE_AGENT,
            args: [],
            resumeArgs: ['resume', '--last'],
            provider: 'OpenAI',
          },
        },
      }),
    );
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    d.send(`${PREFIX}f`);
    await d.waitFor(/task/);
    d.send('codex: add a health check\r');
    await d.waitFor(/Fork into codex\?/);
    await d.waitFor(/summary of this Claude conversation to codex \(OpenAI\)/);
    d.send('y');
    await d.waitFor(/fake agent started in pit-add-a-health-check/);
    await d.waitFor(/codex · fork of main/);
    const calls = fs
      .readFileSync(path.join(env.fakeState, 'agent-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; branch: string });
    expect(calls[0]!.cwd).toBe(path.join(repo, '.claude', 'worktrees', 'pit-add-a-health-check'));
    expect(calls[0]!.branch).toBe('add-a-health-check');
    expect(calls[0]!.argv.at(-1)).toContain('Your only task: add a health check');

    // the second fork into codex doesn't ask again
    d.send(`${PREFIX}1`);
    d.send(`${PREFIX}f`);
    await d.waitFor(/task/);
    d.send('codex: second task\r');
    await d.waitFor(/fake agent started in pit-second-task/);
    expect(d.screen()).not.toMatch(/Fork into codex\?/);

    // quitting warns that agent panes stop
    d.send(`${PREFIX}q`);
    await d.waitFor(/These agent panes stop/);
    d.send('n');
  });

  it('starts a cloud fork after confirming, and records its session link', async () => {
    const bare = tmpDir('pitstop-origin-');
    sh('git', ['init', '-q', '--bare', '-b', 'main'], bare);
    sh('git', ['remote', 'add', 'origin', bare], repo);
    sh('git', ['push', '-q', '-u', 'origin', 'main'], repo);
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    d.send(`${PREFIX}f`);
    await d.waitFor(/no preset/);
    d.send('\t\t\t');
    await d.waitFor(/preset: cloud/);
    d.send('run the slow migration\r');
    await d.waitFor(/Start a cloud fork\?/);
    d.send('y');
    await d.waitFor(/claude\.ai\/code\/session_01FAKE/);
    await d.waitFor(/cloud · fork of main/);
    const repoId = repoContext(repo).repoId;
    let b = listBranches(repoId).find((x) => x.name === 'run-the-slow-migration');
    const start = Date.now();
    while (!b?.cloudSessionId && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      b = listBranches(repoId).find((x) => x.name === 'run-the-slow-migration');
    }
    expect(b!.kind).toBe('cloud');
    expect(b!.cloudSessionId).toMatch(/^session_01FAKE/);
    expect(sh('git', ['branch', '--list', 'pit/run-the-slow-migration'], bare)).toContain(
      'pit/run-the-slow-migration',
    );
  });

  it('writes a report with ctrl+\\ e', async () => {
    d = drive(repo);
    await d.waitFor(/fake claude session/);
    d.send(`${PREFIX}f`);
    await d.waitFor(/task/);
    d.send('report me\r');
    await d.waitFor(/2 . report-me/);
    d.send(`${PREFIX}e`);
    const s = await d.waitFor(/report written: \S+\.md/);
    const file = /report written: (\S+\.md)/.exec(s)![1]!;
    expect(fs.readFileSync(file, 'utf8')).toContain('### report-me');
  });
});
