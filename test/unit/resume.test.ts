import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBranch, loadSession, saveBranch, upsertSession } from '../../src/branches.js';
import { repoContext } from '../../src/core/git.js';
import { forkSession } from '../../src/fork/fork.js';
import { ensureMainSession, mainStatus } from '../../src/fork/main.js';
import { resumeFork, stoppedForks } from '../../src/fork/resume.js';
import { handleHook } from '../../src/hook/entry.js';
import { fakeAgents, fakeCalls, isolate, makeRepo, setFakeAgents } from '../helpers.js';

let env: ReturnType<typeof isolate>;
let repo: string;
const MAIN = '11111111-1111-4111-8111-111111111111';

/** Write a conversation file the way Claude Code does, under its projects folder. */
function conversation(sessionId: string, ageMs = 0): string {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-repo');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, t, t);
  return file;
}

function mainRecord(sessionId = MAIN) {
  upsertSession({
    sessionId,
    role: 'main',
    repoId: repoContext(repo).repoId,
    name: 'repo-main',
    cwd: repo,
  });
}

function runningMain() {
  setFakeAgents(env.fakeState, [
    {
      sessionId: MAIN,
      id: '11111111',
      name: 'repo-main',
      kind: 'background',
      status: 'idle',
      state: 'done',
      cwd: repo,
    },
  ]);
}

/** Everything stopped, as after a reboot. */
const reboot = () => setFakeAgents(env.fakeState, []);
const bgCalls = () => fakeCalls(env.fakeState).filter((c) => c.argv.includes('--bg'));

beforeEach(() => {
  env = isolate();
  repo = makeRepo({ 'app.py': 'print(1)\n' });
});
afterEach(() => env.restore());

describe('resuming main', () => {
  it('continues a stopped main from its conversation instead of starting over', async () => {
    mainRecord();
    conversation(MAIN);
    reboot();
    expect(await mainStatus(repo)).toEqual({ running: undefined, previous: MAIN });
    const m = await ensureMainSession(repo);
    expect(m.resumed).toBe(true);
    expect(m.sessionId).toBe(MAIN);
    const call = bgCalls().at(-1)!;
    // no flags: Claude Code wakes it with its saved options (flags would start a copy)
    expect(call.argv).toEqual(['--bg', '--resume', MAIN]);
    expect(call.cwd).toBe(repo);
  });

  it('picks the most recent of its conversations (it can move to a new id)', async () => {
    const moved = '22222222-2222-4222-8222-222222222222';
    mainRecord();
    mainRecord(moved);
    conversation(MAIN, 60_000);
    conversation(moved);
    reboot();
    const m = await ensureMainSession(repo);
    expect(m.sessionId).toBe(moved);
  });

  it("passes the user's own flags by starting a copy with full history", async () => {
    mainRecord();
    conversation(MAIN);
    reboot();
    await ensureMainSession(repo, ['--model', 'opus']);
    const argv = bgCalls().at(-1)!.argv;
    expect(argv[argv.indexOf('--resume') + 1]).toBe(MAIN);
    expect(argv).toContain('--model');
    expect(argv).toContain('--settings');
  });

  it('reuses a running main, and starts fresh with --new or when there is nothing to continue', async () => {
    mainRecord();
    conversation(MAIN);
    runningMain();
    expect((await ensureMainSession(repo)).reused).toBe(true);
    reboot();
    const fresh = await ensureMainSession(repo, [], undefined, { fresh: true });
    expect(fresh.resumed).toBeUndefined();
    expect(bgCalls().at(-1)!.argv).not.toContain('--resume');
  });

  it('records a moved main conversation as main, not as a fork', () => {
    process.env.PITSTOP_ROLE = 'main';
    try {
      handleHook('SessionStart', {
        session_id: '33333333-3333-4333-8333-333333333333',
        cwd: repo,
        transcript_path: '/x.jsonl',
      });
    } finally {
      delete process.env.PITSTOP_ROLE;
    }
    const s = loadSession('33333333-3333-4333-8333-333333333333')!;
    expect(s.role).toBe('main');
    expect(s.repoId).toBe(repoContext(repo).repoId);
  });
});

describe('resuming forks', () => {
  async function fork(task: string) {
    mainRecord();
    runningMain();
    return forkSession({ cwd: repo, parentSessionId: MAIN, task, mode: 'pane', preset: 'hotfix' });
  }

  it('wakes a stopped fork from the folder it was launched in, with its saved options', async () => {
    const b = await fork('survive a reboot');
    expect(b.sessionCwd).toBe(repo);
    conversation(b.sessionId!);
    reboot();
    expect(stoppedForks([loadBranch(b.repoId, b.name)!], []).map((x) => x.name)).toEqual([b.name]);
    const r = await resumeFork(repo, b.name);
    expect(r.state).toBe('running');
    const call = bgCalls().at(-1)!;
    expect(call.argv).toEqual(['--bg', '--resume', b.sessionId]);
    expect(call.cwd).toBe(repo);
    expect(fakeAgents(env.fakeState).map((a) => a.sessionId)).toContain(b.sessionId);
  });

  it("refuses forks that are running, deleted, over budget, or aren't Claude", async () => {
    const b = await fork('busy one');
    conversation(b.sessionId!);
    await expect(resumeFork(repo, b.name)).rejects.toThrow(/still running/);
    reboot();
    saveBranch({
      ...loadBranch(b.repoId, b.name)!,
      note: 'stopped at its $2 budget',
      budgetUsd: 2,
    });
    await expect(resumeFork(repo, b.name)).rejects.toThrow(/budget/);
    saveBranch({ ...loadBranch(b.repoId, b.name)!, note: undefined, state: 'discarded' });
    await expect(resumeFork(repo, b.name)).rejects.toThrow(/deleted/);
    saveBranch({ ...loadBranch(b.repoId, b.name)!, state: 'idle', kind: 'cloud' });
    await expect(resumeFork(repo, b.name)).rejects.toThrow(/cloud/);
  });
});
