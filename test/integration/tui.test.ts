import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeAgents, fakeCalls, isolate, makeRepo, write, commit } from '../helpers.js';

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
    await d.waitFor(/fork of main · task/);
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
});
