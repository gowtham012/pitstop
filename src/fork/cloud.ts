import { branchForSession, saveBranch, type BranchRecord } from '../branches.js';
import { claudeBin } from '../claude/agents.js';
import { run } from '../core/exec.js';
import { git, repoContext } from '../core/git.js';
import {
  abortFork,
  ConfirmationNeeded,
  ForkError,
  parentDigest,
  prepareFork,
  type ForkRequest,
} from './common.js';
import { summaryForkPrompt } from './prompt.js';
import { createForkWorktree } from './worktree.js';

export const CLOUD_CONFIRM =
  'This pushes a branch with your current work (including uncommitted changes) to origin and starts a Claude cloud session on it. The cloud fork gets a summary of this conversation, not the full transcript.';

/** The cloud session's id and link, read from what `claude --cloud` prints. */
export function parseCloudSession(text: string): { id: string; url: string } | undefined {
  const m = /https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]+)[^\s]*/.exec(text);
  if (m && m[1]) return { id: m[1], url: m[0] };
  const id = /Session ID:\s*((?:session|cse)_[A-Za-z0-9]+)/.exec(text)?.[1];
  return id ? { id, url: `https://claude.ai/code/${id}` } : undefined;
}

export function originUrl(repoTop: string): string | undefined {
  const res = git(['remote', 'get-url', 'origin'], repoTop);
  return res.code === 0 ? res.stdout.trim() : undefined;
}

/**
 * Fork into a Claude cloud session. A cloud session clones the GitHub
 * remote, and a local conversation can't be sent to it, so pitstop pushes
 * the fork's starting point (the snapshot, uncommitted work included) to
 * pit/<name> and starts the session on that branch with a summary of the
 * conversation. The work comes back when the session pushes to pit/<name>.
 */
export async function forkCloud(req: ForkRequest): Promise<BranchRecord> {
  const ctx = repoContext(req.cwd);
  if (!originUrl(ctx.top)) {
    throw new ForkError(
      'Cloud forks need a git remote named "origin" (a GitHub repository the Claude GitHub app or /web-setup can push to).',
    );
  }
  const parentBranch = branchForSession(req.parentSessionId);
  if (parentBranch && (parentBranch.kind === 'agent' || parentBranch.kind === 'cloud')) {
    throw new ForkError(
      `Only Claude sessions on this machine can be forked; "${parentBranch.name}" can't.`,
    );
  }
  if (!req.confirmed) throw new ConfirmationNeeded('cloud', CLOUD_CONFIRM);

  const p = await prepareFork({ ...req, cloud: true });
  try {
    const worktree = createForkWorktree(p.branch, p.cfg.setup);
    const push = await run('git', ['push', '-u', 'origin', p.branch.gitBranch], {
      cwd: worktree,
      timeoutMs: 120_000,
    });
    if (push.code !== 0)
      throw new ForkError(`git push failed: ${push.stderr.trim() || push.stdout.trim()}`);
    const prompt = summaryForkPrompt({
      kind: 'cloud',
      name: p.branch.name,
      task: req.task,
      parentName: p.parentName,
      digest: parentDigest(p),
      gitBranch: p.branch.gitBranch,
      portOffset: p.branch.portOffset,
      mergeMode: p.cfg.merge.mode,
    });
    return saveBranch({
      ...p.branch,
      worktree,
      snapshotRef: undefined,
      remoteHead: p.snap.commit,
      launch: { cmd: claudeBin(), args: ['--cloud', prompt], cwd: worktree },
    });
  } catch (err) {
    return abortFork(p, err);
  }
}

/** Current head of the fork's branch on origin, or undefined when it can't be read. */
export async function remoteHead(b: BranchRecord): Promise<string | undefined> {
  const res = await run('git', ['ls-remote', 'origin', `refs/heads/${b.gitBranch}`], {
    cwd: b.repoTop,
    timeoutMs: 30_000,
  });
  if (res.code !== 0) return undefined;
  return res.stdout.trim().split(/\s+/)[0] || undefined;
}

/** True once the cloud session has pushed work beyond the starting point. */
export function cloudForkReady(b: BranchRecord): boolean {
  return !!b.remoteHead && b.remoteHead !== b.snapshotCommit;
}

/** Send a follow-up message to the fork's cloud session. */
export async function messageCloudFork(b: BranchRecord, message: string): Promise<string> {
  if (!b.cloudSessionId)
    throw new ForkError(`The cloud session for "${b.name}" hasn't reported its id yet.`);
  const res = await run(claudeBin(), ['-p', message, '--cloud', b.cloudSessionId], {
    timeoutMs: 60_000,
  });
  if (res.code !== 0)
    throw new ForkError(res.stderr.trim() || res.stdout.trim() || 'sending failed');
  return res.stdout.trim();
}
