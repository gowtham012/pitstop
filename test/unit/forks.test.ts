import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBranch, upsertSession } from '../../src/branches.js';
import { conversationDigest, digestTurns } from '../../src/claude/digest.js';
import type { TranscriptRecord } from '../../src/claude/transcript.js';
import { repoContext } from '../../src/core/git.js';
import {
  agentConsentGiven,
  ConfirmationNeeded,
  recordAgentConsent,
} from '../../src/fork/common.js';
import { cloudForkReady, parseCloudSession, remoteHead } from '../../src/fork/cloud.js';
import { forkSession } from '../../src/fork/fork.js';
import { deleteFork, mergeBranch } from '../../src/merge/merge.js';
import { claimInbox } from '../../src/inbox.js';
import { isolate, makeRepo, read, setFakeAgents, sh, tmpDir, write } from '../helpers.js';

const MAIN = '22222222-2222-4222-8222-222222222222';
let env: ReturnType<typeof isolate>;
let repo: string;

function seedMain(withTranscript = true) {
  setFakeAgents(env.fakeState, [
    {
      sessionId: MAIN,
      id: '22222222',
      name: 'repo-main',
      kind: 'background',
      status: 'idle',
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
  if (!withTranscript) return;
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'repo');
  fs.mkdirSync(dir, { recursive: true });
  const lines: TranscriptRecord[] = [
    {
      type: 'user',
      uuid: 'a',
      parentUuid: null,
      message: { role: 'user', content: 'Remember the codename BLUEBIRD-42.' },
    },
    {
      type: 'assistant',
      uuid: 'b',
      parentUuid: 'a',
      message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
    },
  ];
  fs.writeFileSync(
    path.join(dir, `${MAIN}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

beforeEach(() => {
  env = isolate();
  repo = makeRepo({ 'app.py': 'print(1)\n' });
});
afterEach(() => env.restore());

describe('conversation digest', () => {
  const rec = (
    type: string,
    uuid: string,
    parent: string | null,
    content: unknown,
    extra = {},
  ): TranscriptRecord => ({
    type,
    uuid,
    parentUuid: parent,
    message: { role: type, content },
    ...extra,
  });

  it('keeps what was said and one line per tool call, and drops tool output', () => {
    const turns = digestTurns([
      rec('user', 'a', null, 'run the tests'),
      rec('assistant', 'b', 'a', [
        { type: 'text', text: 'Running them.' },
        { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pytest -q' } },
      ]),
      rec('user', 'c', 'b', [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET OUTPUT' }]),
      rec('assistant', 's', 'c', [{ type: 'text', text: 'subagent noise' }], { isSidechain: true }),
      rec('assistant', 'd', 'c', [{ type: 'text', text: 'All green.' }]),
    ]);
    expect(turns).toEqual([
      'User: run the tests',
      'Claude: Running them.\n[ran Bash: pytest -q]',
      'Claude: All green.',
    ]);
  });

  it('drops the oldest turns first to fit the limit', () => {
    const records: TranscriptRecord[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 50; i++) {
      records.push(rec('user', `u${i}`, parent, `question ${i} ${'x'.repeat(200)}`));
      records.push(rec('assistant', `a${i}`, `u${i}`, [{ type: 'text', text: `answer ${i}` }]));
      parent = `a${i}`;
    }
    const d = conversationDigest(records, { maxChars: 2000, sessionName: 'app-main' });
    expect(d.length).toBeLessThanOrEqual(2100);
    expect(d).toContain('answer 49');
    expect(d).not.toContain('question 0 ');
    expect(d).toMatch(/earlier turns left out/);
    expect(d).toContain('"app-main"');
  });
});

describe('agent forks', () => {
  it('asks once before sending a summary to another provider, then remembers', async () => {
    seedMain();
    await expect(
      forkSession({ cwd: repo, parentSessionId: MAIN, task: 'x', preset: 'codex', mode: 'pane' }),
    ).rejects.toBeInstanceOf(ConfirmationNeeded);
    const repoId = repoContext(repo).repoId;
    expect(agentConsentGiven(repoId, 'codex')).toBe(false);
    recordAgentConsent(repoId, 'codex');
    expect(agentConsentGiven(repoId, 'codex')).toBe(true);
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'add a health check',
      preset: 'codex',
      mode: 'pane',
    });
    expect(b.kind).toBe('agent');
  });

  it('builds the worktree from the snapshot and records the agent command with the summary', async () => {
    seedMain();
    write(repo, 'app.py', 'print("wip")\n');
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'write the codename to code.txt',
      preset: 'codex',
      mode: 'pane',
      confirmed: true,
    });
    expect(b.kind).toBe('agent');
    expect(b.agent).toBe('codex');
    expect(b.forkMethod).toBe('summary');
    expect(b.worktree).toBe(path.join(repo, '.claude', 'worktrees', `pit-${b.name}`));
    expect(read(b.worktree!, 'app.py')).toBe('print("wip")\n');
    expect(b.launch!.cmd).toBe('codex');
    expect(b.launch!.cwd).toBe(b.worktree);
    expect(b.launch!.env).toEqual({ PITSTOP_BRANCH: b.name, PITSTOP_PORT_OFFSET: '100' });
    const prompt = b.launch!.args.at(-1)!;
    expect(prompt).toContain('Your only task: write the codename to code.txt');
    expect(prompt).toContain('BLUEBIRD-42'); // the parent's context, via the summary
    expect(b.resumeArgs).toEqual(['resume', '--last']);
  });

  it('merges an agent fork like any other and saves what the report needs', async () => {
    seedMain();
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'codename',
      preset: 'gemini',
      mode: 'pane',
      confirmed: true,
    });
    expect(b.launch!.args.slice(0, 1)).toEqual(['-i']);
    write(b.worktree!, 'code.txt', 'BLUEBIRD-42\n'); // the agent left it uncommitted
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('commit');
    expect(read(repo, 'code.txt')).toBe('BLUEBIRD-42\n');
    const saved = loadBranch(b.repoId, b.name)!;
    expect(saved.commits).toHaveLength(1);
    expect(saved.diffstat).toContain('code.txt');
    expect(saved.filesChanged).toEqual(['code.txt']);
    expect(claimInbox(MAIN)[0]!.text).toContain('code.txt');
  });

  it('refuses to fork from an agent fork', async () => {
    seedMain();
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'one',
      preset: 'codex',
      mode: 'pane',
      confirmed: true,
    });
    upsertSession({ sessionId: 'agent-pane', role: 'fork', repoId: b.repoId, branch: b.name });
    await expect(
      forkSession({
        cwd: repo,
        parentSessionId: 'agent-pane',
        task: 'two',
        preset: 'codex',
        mode: 'pane',
        confirmed: true,
      }),
    ).rejects.toThrow(/Only Claude sessions/);
  });

  it('saves the work of a deleted fork for the report, and leaves agent conversations alone', async () => {
    seedMain();
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'throwaway',
      preset: 'codex',
      mode: 'pane',
      confirmed: true,
    });
    write(b.worktree!, 'junk.txt', 'x\n');
    const d = await deleteFork(repo, b.name, { conversation: true });
    expect(d.branch.state).toBe('discarded');
    expect(d.branch.filesChanged).toEqual(['junk.txt']);
    expect(d.removedFiles).toEqual([]);
    expect(d.notes.join()).toMatch(/kept by codex/);
  });
});

describe('cloud forks', () => {
  function addOrigin(): string {
    const bare = tmpDir('pitstop-origin-');
    sh('git', ['init', '-q', '--bare', '-b', 'main'], bare);
    sh('git', ['remote', 'add', 'origin', bare], repo);
    sh('git', ['push', '-q', '-u', 'origin', 'main'], repo);
    return bare;
  }

  /** Stand in for the cloud session: clone the branch, commit, push. */
  function cloudPushes(bare: string, branch: string, file: string, content: string) {
    const clone = tmpDir('pitstop-cloud-');
    sh('git', ['clone', '-q', '-b', branch, bare, clone], clone);
    write(clone, file, content);
    sh('git', ['add', '-A'], clone);
    sh(
      'git',
      ['-c', 'user.name=cloud', '-c', 'user.email=c@c', 'commit', '-q', '-m', `cloud: ${file}`],
      clone,
    );
    sh('git', ['push', '-q', 'origin', branch], clone);
  }

  it("needs an origin remote and the user's go-ahead", async () => {
    seedMain();
    await expect(
      forkSession({ cwd: repo, parentSessionId: MAIN, task: 'x', preset: 'cloud', mode: 'pane' }),
    ).rejects.toThrow(/origin/);
    addOrigin();
    await expect(
      forkSession({ cwd: repo, parentSessionId: MAIN, task: 'x', preset: 'cloud', mode: 'pane' }),
    ).rejects.toBeInstanceOf(ConfirmationNeeded);
  });

  it('pushes the snapshot, starts from a summary, and merges what the cloud pushed back', async () => {
    seedMain();
    const bare = addOrigin();
    write(repo, 'app.py', 'print("wip")\n');
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'write the codename to cloud.txt',
      preset: 'cloud',
      mode: 'pane',
      confirmed: true,
    });
    expect(b.kind).toBe('cloud');
    // the starting point, uncommitted work included, is on origin
    expect(sh('git', ['show', `${b.gitBranch}:app.py`], bare)).toBe('print("wip")');
    expect(b.launch!.args[0]).toBe('--cloud');
    expect(b.launch!.args[1]).toContain('BLUEBIRD-42');
    expect(b.launch!.args[1]).toContain(`push your work to ${b.gitBranch}`);
    expect(await remoteHead(b)).toBe(b.snapshotCommit);
    expect(cloudForkReady(b)).toBe(false);

    cloudPushes(bare, b.gitBranch, 'cloud.txt', 'BLUEBIRD-42\n');
    const head = await remoteHead(b);
    expect(head).not.toBe(b.snapshotCommit);
    expect(cloudForkReady({ ...b, remoteHead: head })).toBe(true);

    write(repo, 'app.py', 'print(1)\n'); // main tidied up meanwhile
    const res = await mergeBranch(repo, b.name);
    expect(res.strategy).toBe('commit');
    expect(read(repo, 'cloud.txt')).toBe('BLUEBIRD-42\n');
    // remote branch cleaned up
    expect(sh('git', ['branch', '--list', b.gitBranch], bare)).toBe('');
  });

  it('merges from another branch when the cloud session could not push to pit/<name>', async () => {
    seedMain();
    const bare = addOrigin();
    const b = await forkSession({
      cwd: repo,
      parentSessionId: MAIN,
      task: 'elsewhere',
      preset: 'cloud',
      mode: 'pane',
      confirmed: true,
    });
    const clone = tmpDir('pitstop-cloud-');
    sh('git', ['clone', '-q', '-b', b.gitBranch, bare, clone], clone);
    sh('git', ['checkout', '-q', '-b', 'claude/other'], clone);
    write(clone, 'other.txt', 'o\n');
    sh('git', ['add', '-A'], clone);
    sh('git', ['-c', 'user.name=c', '-c', 'user.email=c@c', 'commit', '-q', '-m', 'other'], clone);
    sh('git', ['push', '-q', 'origin', 'claude/other'], clone);
    const res = await mergeBranch(repo, b.name, { fromBranch: 'claude/other' });
    expect(res.strategy).toBe('commit');
    expect(read(repo, 'other.txt')).toBe('o\n');
  });

  it('reads the session id and link from what claude --cloud prints', () => {
    expect(
      parseCloudSession('Starting…\nView: https://claude.ai/code/session_01AbC?from=cli&m=0\n'),
    ).toEqual({
      id: 'session_01AbC',
      url: 'https://claude.ai/code/session_01AbC?from=cli&m=0',
    });
    expect(parseCloudSession('Session ID: cse_99x')).toEqual({
      id: 'cse_99x',
      url: 'https://claude.ai/code/cse_99x',
    });
    expect(parseCloudSession('nothing yet')).toBeUndefined();
  });
});
