import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listBranches,
  loadBranch,
  loadSession,
  saveBranch,
  upsertSession,
} from '../../src/branches.js';
import { trustRepoCommands } from '../../src/core/config.js';
import { repoContext } from '../../src/core/git.js';
import { snapshotWorkingTree } from '../../src/core/snapshot.js';
import { withLock } from '../../src/core/store.js';
import { forkSession } from '../../src/fork/fork.js';
import { createPlainWorktree, safeSetupSource } from '../../src/fork/worktree.js';
import { handleHook } from '../../src/hook/entry.js';
import { claimInbox, sendInbox } from '../../src/inbox.js';
import { clearHistory, deleteFork, mergeBranch, pullFromParent } from '../../src/merge/merge.js';
import { scanRadar } from '../../src/radar.js';
import { SEAL_TOOL_RESULT } from '../../src/claude/transcript.js';
import {
  commit,
  fakeAgents,
  fakeCalls,
  isolate,
  makeRepo,
  read,
  setFakeAgents,
  sh,
  write,
} from '../helpers.js';

let env: ReturnType<typeof isolate>;
let repo: string;
const MAIN = '11111111-1111-4111-8111-111111111111';

function seedMain(status = 'idle') {
  setFakeAgents(env.fakeState, [
    {
      sessionId: MAIN,
      id: '11111111',
      name: 'repo-main',
      kind: 'background',
      status,
      state: 'done',
      cwd: repo,
    },
  ]);
  upsertSession({
    sessionId: MAIN,
    role: 'main',
    repoId: repoContext(repo).repoId,
    name: 'repo-main',
    cwd: repo,
  });
}

/** Simulate the fork's first edit: Claude Code calls WorktreeCreate, then the agent commits work. */
function startWorking(sessionId: string, files: Record<string, string>) {
  const out = handleHook('WorktreeCreate', { session_id: sessionId, cwd: repo, name: 'x' });
  const wt = out.stdout!;
  for (const [f, c] of Object.entries(files)) write(wt, f, c);
  return wt;
}

beforeEach(() => {
  env = isolate();
  repo = makeRepo({ 'app.py': 'print("v1")\n', 'README.md': '# demo\n' });
});
afterEach(() => env.restore());

describe('snapshot', () => {
  it('freezes uncommitted and untracked work without touching the index or files', () => {
    write(repo, 'app.py', 'print("wip")\n');
    write(repo, 'new.txt', 'untracked\n');
    sh('git', ['add', 'app.py'], repo);
    const before = sh('git', ['status', '--porcelain'], repo);
    const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));
    const snap = snapshotWorkingTree(repo, 't');
    expect(snap.dirty).toBe(true);
    expect(sh('git', ['status', '--porcelain'], repo)).toBe(before);
    expect(fs.readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(sh('git', ['show', `${snap.commit}:new.txt`], repo)).toBe('untracked');
    expect(sh('git', ['show', `${snap.commit}:app.py`], repo)).toBe('print("wip")');
  });

  it('returns HEAD when the tree is clean', () => {
    const snap = snapshotWorkingTree(repo, 't');
    expect(snap.dirty).toBe(false);
    expect(snap.commit).toBe(sh('git', ['rev-parse', 'HEAD'], repo));
  });
});

describe('fork', () => {
  it('forks an idle parent natively, with marker prompt and per-session hooks', async () => {
    seedMain('idle');
    write(repo, 'app.py', 'print("wip")\n');
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'Fix the login bug',
      mode: 'pane',
    });
    expect(b.name).toBe('fix-the-login-bug');
    expect(b.forkMethod).toBe('native');
    expect(b.state).toBe('running');
    expect(b.portSlot).toBe(1);
    const call = fakeCalls(env.fakeState).find((c) => c.argv.includes('--bg'))!;
    expect(call.argv).toContain('--fork-session');
    expect(call.argv[call.argv.indexOf('--resume') + 1]).toBe(MAIN);
    const settings = JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]!);
    expect(Object.keys(settings.hooks)).toEqual(
      expect.arrayContaining(['WorktreeCreate', 'PreToolUse', 'PostToolUse', 'SessionStart']),
    );
    expect(settings.env.PITSTOP_PORT_OFFSET).toBe('100');
    expect(call.argv.at(-1)).toContain('[pitstop:fix-the-login-bug parent=');
    // the parent's checkout is untouched
    expect(read(repo, 'app.py')).toBe('print("wip")\n');
  });

  it('seals a copy instead of forking natively when the parent is mid-turn', async () => {
    seedMain('busy');
    const projectDir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'repo');
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      {
        type: 'user',
        uuid: 'a',
        parentUuid: null,
        sessionId: MAIN,
        message: { role: 'user', content: 'run tests' },
      },
      {
        type: 'assistant',
        uuid: 'b',
        parentUuid: 'a',
        sessionId: MAIN,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pytest' } }],
        },
      },
    ];
    fs.writeFileSync(
      path.join(projectDir, `${MAIN}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );
    const b = await forkSession({ cwd: repo, parentSessionId: MAIN, task: 'hotfix', mode: 'pane' });
    expect(b.forkMethod).toBe('sealed');
    expect(b.pendingAtFork).toEqual(['Bash pytest']);
    const call = fakeCalls(env.fakeState).find((c) => c.argv.includes('--bg'))!;
    expect(call.argv).not.toContain('--fork-session');
    const copyId = call.argv[call.argv.indexOf('--resume') + 1]!;
    const copy = fs.readFileSync(path.join(projectDir, `${copyId}.jsonl`), 'utf8');
    expect(copy).toContain(SEAL_TOOL_RESULT);
    expect(call.argv.at(-1)).toContain('Do not run it again');
  });

  it('refuses to go past the session cap', async () => {
    seedMain();
    write(repo, '.pitstop.json', JSON.stringify({ maxSessions: 2 }));
    commit(repo, 'cfg');
    await forkSession({ cwd: repo, parentSessionId: MAIN, task: 'one', mode: 'pane' });
    await expect(
      forkSession({ cwd: repo, parentSessionId: MAIN, task: 'two', mode: 'pane' }),
    ).rejects.toThrow(/limit 2/);
  });

  it('reports an untrusted workspace clearly and marks the fork failed', async () => {
    seedMain();
    process.env.FAKE_CLAUDE_UNTRUSTED = '1';
    try {
      await expect(
        forkSession({ cwd: repo, parentSessionId: MAIN, task: 'x', mode: 'pane' }),
      ).rejects.toThrow(/trust/);
    } finally {
      delete process.env.FAKE_CLAUDE_UNTRUSTED;
    }
    expect(listBranches(repoContext(repo).repoId)[0]!.state).toBe('failed');
  });
});

describe('hooks', () => {
  it('builds the fork worktree from the snapshot and guards writes outside it', async () => {
    seedMain();
    write(repo, 'app.py', 'print("wip")\n');
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'guard me',
      mode: 'pane',
    });
    const wt = startWorking(b.sessionId!, {});
    expect(wt).toBe(path.join(repo, '.claude', 'worktrees', 'pit-guard-me'));
    expect(read(wt, 'app.py')).toBe('print("wip")\n'); // sees the parent's uncommitted work
    expect(sh('git', ['status', '--porcelain'], repo)).toBe('M app.py'); // worktree dir excluded
    const deny = handleHook('PreToolUse', {
      session_id: b.sessionId!,
      cwd: wt,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(repo, 'app.py') },
    });
    expect(JSON.parse(deny.stdout!).hookSpecificOutput.permissionDecision).toBe('deny');
    const allow = handleHook('PreToolUse', {
      session_id: b.sessionId!,
      cwd: wt,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(wt, 'app.py') },
    });
    expect(allow.stdout).toBeUndefined();
  });

  it('maps a session to its fork from the marker in its prompt', async () => {
    seedMain();
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'by marker',
      mode: 'pane',
    });
    const other = crypto.randomUUID();
    saveBranch({ ...b, sessionId: undefined });
    handleHook('UserPromptSubmit', {
      session_id: other,
      cwd: repo,
      prompt: `[pitstop:${b.name} parent=${MAIN}] Your only task: x`,
    });
    expect(loadBranch(b.repoId, b.name)!.sessionId).toBe(other);
  });

  it('delivers inbox messages once, after a tool call', () => {
    sendInbox({
      to: MAIN,
      from: 'fix',
      kind: 'merged',
      text: 'fork fix was merged',
      files: ['a.py'],
    });
    const first = handleHook('PostToolUse', { session_id: MAIN });
    expect(JSON.parse(first.stdout!).hookSpecificOutput.additionalContext).toContain(
      'fork fix was merged',
    );
    expect(handleHook('PostToolUse', { session_id: MAIN }).stdout).toBeUndefined();
    expect(claimInbox(MAIN)).toEqual([]);
  });
});

describe('merge', () => {
  async function forkWithWork(task: string, files: Record<string, string>) {
    const b = await forkSession({ cwd: repo, parentSessionId: MAIN, task, mode: 'pane' });
    startWorking(b.sessionId!, files);
    return loadBranch(b.repoId, b.name)!;
  }

  it('merges with a commit when the parent is clean, tells the parent, and cleans up', async () => {
    seedMain();
    const b = await forkWithWork('fix login', { 'auth.py': 'ok\n' });
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('commit');
    expect(read(repo, 'auth.py')).toBe('ok\n');
    expect(fs.existsSync(b.worktree!)).toBe(false);
    expect(sh('git', ['branch', '--list', b.gitBranch], repo)).toBe('');
    const [note] = claimInbox(MAIN);
    expect(note!.kind).toBe('merged');
    expect(note!.files).toEqual(['auth.py']);
    expect(fakeAgents(env.fakeState).some((a) => a.sessionId === b.sessionId)).toBe(false);
  });

  it('applies as unstaged changes when the parent is mid-edit in other files', async () => {
    seedMain();
    write(repo, 'README.md', '# parent is editing\n');
    const b = await forkWithWork('fix login', { 'auth.py': 'ok\n' });
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('apply');
    expect(read(repo, 'auth.py')).toBe('ok\n');
    expect(read(repo, 'README.md')).toBe('# parent is editing\n');
    expect(sh('git', ['diff', '--cached', '--name-only'], repo)).toBe(''); // nothing staged
  });

  it('defers when the parent has uncommitted changes in the same file', async () => {
    seedMain();
    const b = await forkWithWork('touch app', { 'app.py': 'print("fork")\n' });
    write(repo, 'app.py', 'print("parent")\n');
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('defer');
    expect(read(repo, 'app.py')).toBe('print("parent")\n');
    expect(loadBranch(b.repoId, b.name)!.state).toBe('deferred');
    expect(claimInbox(MAIN)[0]!.text).toContain('NOT merged');
    // still live and still overlapping, so the radar keeps warning about it
    expect(await scanRadar(repo, listBranches(b.repoId))).toEqual([
      { file: 'app.py', sessions: ['main', 'touch-app'] },
    ]);
  });

  it('blocks the merge when the test gate fails', async () => {
    seedMain();
    write(
      repo,
      '.pitstop.json',
      JSON.stringify({ test: 'test -f must-exist.txt', testGate: true }),
    );
    commit(repo, 'cfg');
    trustRepoCommands(repo, { test: 'test -f must-exist.txt' });
    const b = await forkWithWork('gated', { 'x.py': '1\n' });
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('blocked');
    expect(res.gate!.ok).toBe(false);
    expect(fs.existsSync(path.join(repo, 'x.py'))).toBe(false);
    const ok = await forkWithWork('gated ok', { 'must-exist.txt': 'y\n' });
    expect((await mergeBranch(repo, ok.name)).strategy).toBe('commit');
  });

  it('runs merges one at a time and rebases the second onto the first', async () => {
    seedMain();
    const a = await forkWithWork('first', { 'a.py': 'a\n' });
    const b = await forkWithWork('second', { 'b.py': 'b\n' });
    const [ra, rb] = await Promise.all([mergeBranch(repo, a.name), mergeBranch(repo, b.name)]);
    expect([ra.strategy, rb.strategy]).toEqual(['commit', 'commit']);
    expect(read(repo, 'a.py')).toBe('a\n');
    expect(read(repo, 'b.py')).toBe('b\n');
    expect(sh('git', ['log', '--merges', '--oneline'], repo).split('\n')).toHaveLength(2);
  });

  it('spots two sessions changing the same file', async () => {
    seedMain();
    const b = await forkSession({ cwd: repo, parentSessionId: MAIN, task: 'radar', mode: 'pane' });
    startWorking(b.sessionId!, { 'README.md': '# fork\n' });
    write(repo, 'README.md', '# main\n');
    expect(await scanRadar(repo, listBranches(b.repoId))).toEqual([
      { file: 'README.md', sessions: ['main', 'radar'] },
    ]);
  });

  it("pulls the parent's latest commits into a fork", async () => {
    seedMain();
    const b = await forkWithWork('pull me', {});
    write(b.worktree!, 'fork.txt', 'f\n');
    commit(b.worktree!, 'fork work');
    write(repo, 'main.txt', 'm\n');
    commit(repo, 'main work');
    expect(pullFromParent(repo, b.name).outcome).toBe('ok');
    expect(read(b.worktree!, 'main.txt')).toBe('m\n');
    expect(read(b.worktree!, 'fork.txt')).toBe('f\n');
    expect(pullFromParent(repo, b.name).outcome).toBe('up-to-date');
  });

  it('deletes a fork: worktree and branch go, the record stays as deleted', async () => {
    seedMain();
    const b = await forkWithWork('throwaway', { 'junk.txt': 'x\n' });
    const r = await deleteFork(repo, b.name);
    expect(r.forgotten).toBe(false);
    expect(fs.existsSync(b.worktree!)).toBe(false);
    expect(loadBranch(b.repoId, b.name)!.state).toBe('discarded');
    expect(sh('git', ['branch', '--list', b.gitBranch], repo)).toBe('');
    expect(fakeCalls(env.fakeState).some((c) => c.argv[0] === 'rm')).toBe(true);
  });

  it('forgets a fork: its record and session entry are removed too', async () => {
    seedMain();
    const b = await forkWithWork('forget me', { 'junk.txt': 'x\n' });
    const r = await deleteFork(repo, b.name, { forget: true });
    expect(r.forgotten).toBe(true);
    expect(loadBranch(b.repoId, b.name)).toBeUndefined();
    expect(loadSession(b.sessionId!)).toBeUndefined();
  });

  it('deleting a fork that is already merged only removes its record', async () => {
    seedMain();
    const b = await forkWithWork('merged one', { 'm.txt': 'm\n' });
    await mergeBranch(repo, b.name);
    const head = sh('git', ['rev-parse', 'HEAD'], repo);
    const r = await deleteFork(repo, b.name);
    expect(r.forgotten).toBe(true);
    expect(loadBranch(b.repoId, b.name)).toBeUndefined();
    expect(sh('git', ['rev-parse', 'HEAD'], repo)).toBe(head);
    expect(read(repo, 'm.txt')).toBe('m\n');
  });

  it("deletes the fork's conversation and never the parent's", async () => {
    seedMain();
    const b = await forkWithWork('secret work', { 's.txt': 's\n' });
    const proj = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-repo');
    fs.mkdirSync(path.join(proj, b.sessionId!, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(proj, `${b.sessionId}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(proj, `${MAIN}.jsonl`), '{}\n');
    const r = await deleteFork(repo, b.name, { conversation: true });
    expect(r.removedFiles.sort()).toEqual(
      [path.join(proj, `${b.sessionId}.jsonl`), path.join(proj, b.sessionId!)].sort(),
    );
    expect(fs.existsSync(path.join(proj, `${b.sessionId}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(proj, b.sessionId!))).toBe(false);
    expect(fs.existsSync(path.join(proj, `${MAIN}.jsonl`))).toBe(true);
  });

  it('refuses to delete a conversation file outside Claude projects folder', async () => {
    seedMain();
    const b = await forkWithWork('odd path', { 'o.txt': 'o\n' });
    const outside = path.join(env.home, `${b.sessionId}.jsonl`);
    fs.writeFileSync(outside, '{}\n');
    upsertSession({ sessionId: b.sessionId!, transcriptPath: outside });
    await expect(deleteFork(repo, b.name, { conversation: true })).rejects.toThrow(/Refusing/);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('clears merged and deleted forks from the history, keeping live ones', async () => {
    seedMain();
    const merged = await forkWithWork('merge it', { 'a.txt': 'a\n' });
    await mergeBranch(repo, merged.name);
    const gone = await forkWithWork('drop it', { 'b.txt': 'b\n' });
    await deleteFork(repo, gone.name);
    const live = await forkWithWork('keep it', { 'c.txt': 'c\n' });
    const done = await clearHistory(repo);
    expect(done.map((r) => r.branch.name).sort()).toEqual([gone.name, merged.name].sort());
    expect(listBranches(live.repoId).map((b) => b.name)).toEqual([live.name]);
  });
});

describe('repo config safety', () => {
  it('ignores repo commands until the user trusts them', async () => {
    seedMain();
    write(repo, '.pitstop.json', JSON.stringify({ test: 'false', testGate: true }));
    commit(repo, 'cfg');
    const b = await forkWithWorkTop('untrusted gate', { 'y.py': '1\n' });
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('commit'); // gate command dropped, not run
    expect(res.gate).toBeUndefined();
  });

  it('only copies setup files that stay inside the repo', () => {
    write(repo, 'inside.env', 'A=1\n');
    expect(safeSetupSource(repo, 'inside.env')).toBe(path.join(repo, 'inside.env'));
    expect(safeSetupSource(repo, '../outside')).toBeUndefined();
    expect(safeSetupSource(repo, '/etc/passwd')).toBeUndefined();
    fs.symlinkSync('/etc', path.join(repo, 'link'));
    expect(safeSetupSource(repo, 'link')).toBeUndefined();
  });

  it('sanitizes worktree names from Claude Code', () => {
    const dir = createPlainWorktree(repo, '../../escape me');
    expect(dir).toBe(path.join(repo, '.claude', 'worktrees', 'escape-me'));
  });

  it('blocks writes through a symlink that leads into the main checkout', async () => {
    seedMain();
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'symlink',
      mode: 'pane',
    });
    const wt = startWorking(b.sessionId!, {});
    fs.symlinkSync(repo, path.join(wt, 'parent'));
    const out = handleHook('PreToolUse', {
      session_id: b.sessionId!,
      cwd: wt,
      tool_name: 'Write',
      tool_input: { file_path: path.join(wt, 'parent', 'app.py') },
    });
    expect(JSON.parse(out.stdout!).hookSpecificOutput.permissionDecision).toBe('deny');
    const cd = handleHook('PreToolUse', {
      session_id: b.sessionId!,
      cwd: wt,
      tool_name: 'Bash',
      tool_input: { command: 'cd ../../.. && git stash' },
    });
    expect(JSON.parse(cd.stdout!).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

async function forkWithWorkTop(task: string, files: Record<string, string>) {
  const b = await forkSession({ cwd: repo, parentSessionId: MAIN, task, mode: 'pane' });
  startWorking(b.sessionId!, files);
  return loadBranch(b.repoId, b.name)!;
}

describe('locks', () => {
  it('serializes critical sections', async () => {
    const lock = path.join(env.home, 'l.lock');
    const order: string[] = [];
    await Promise.all(
      [1, 2, 3].map((i) =>
        withLock(lock, async () => {
          order.push(`start${i}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end${i}`);
        }),
      ),
    );
    for (let i = 0; i < order.length; i += 2)
      expect(order[i]!.slice(-1)).toBe(order[i + 1]!.slice(-1));
  });
});
