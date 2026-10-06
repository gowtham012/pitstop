import fs from 'node:fs';
import path from 'node:path';
import { branchKind, loadBranch, saveBranch, type BranchRecord } from '../branches.js';
import { sessionCost } from '../status.js';
import { isBusy, listAgentsAsync, removeSession, stopSession } from '../claude/agents.js';
import { loadConfig } from '../core/config.js';
import { run, runSync } from '../core/exec.js';
import {
  commitAll,
  deleteBranch,
  dirtyFiles,
  git,
  gitOk,
  head,
  identityEnv,
  isClean,
  repoContext,
  revCount,
  worktreeRemove,
} from '../core/git.js';
import { repoStateDir } from '../core/paths.js';
import { dropSnapshotRef } from '../core/snapshot.js';
import { withLock } from '../core/store.js';
import { sendInbox } from '../inbox.js';
import { runTestGate, type GateResult } from './gate.js';
import { planMerge, type MergeStrategy } from './plan.js';

export class MergeError extends Error {}

export interface MergeOptions {
  /** Force a strategy instead of letting the decision table pick. */
  strategy?: Exclude<MergeStrategy, 'nothing'>;
  /** Keep the worktree and session after merging. */
  keep?: boolean;
  skipTests?: boolean;
  /** Merge even if the fork's session is still mid-turn. */
  force?: boolean;
  /** Cloud forks: fetch this branch from origin instead of pit/<name> (when the session pushed elsewhere). */
  fromBranch?: string;
}

export interface MergeResult {
  branch: BranchRecord;
  strategy: MergeStrategy | 'blocked';
  reason: string;
  files: string[];
  gate?: GateResult;
}

/** Directory the fork's parent is editing: another fork's worktree, or the main checkout. */
export function parentDirOf(b: BranchRecord): string {
  if (b.parentBranch) {
    const p = loadBranch(b.repoId, b.parentBranch);
    if (p?.worktree && fs.existsSync(p.worktree)) return p.worktree;
  }
  return b.repoTop;
}

function changedFiles(cwd: string, from: string, to: string): string[] {
  const res = git(['diff', '--name-only', '-z', `${from}..${to}`], cwd);
  return res.code === 0 ? res.stdout.split('\0').filter(Boolean) : [];
}

/** What `pit report` needs about a fork's work, captured before its branch is deleted. */
export function workSummary(
  repoTop: string,
  base: string,
  branch: string,
): Pick<BranchRecord, 'commits' | 'diffstat' | 'filesChanged'> {
  const log = git(['log', '--oneline', '--no-decorate', `${base}..${branch}`], repoTop);
  const stat = git(['diff', '--stat', `${base}..${branch}`], repoTop);
  return {
    commits: log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [],
    diffstat: stat.code === 0 ? stat.stdout.trimEnd() : '',
    filesChanged: changedFiles(repoTop, base, branch),
  };
}

function sessionFacts(b: BranchRecord): Pick<BranchRecord, 'lastMessage' | 'costUsd'> {
  const c = b.sessionId ? sessionCost(b.sessionId) : undefined;
  return c ? { lastMessage: c.last?.slice(0, 2000), costUsd: c.usd } : {};
}

/** Bring a cloud fork's pushed work into its local branch (and worktree). */
function fetchCloudWork(b: BranchRecord, wt: string | undefined, fromBranch?: string): void {
  const remoteBranch = fromBranch ?? b.gitBranch;
  const fetch = git(['fetch', 'origin', remoteBranch], b.repoTop);
  if (fetch.code !== 0) {
    throw new MergeError(
      `git fetch origin ${remoteBranch} failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
    );
  }
  const fetched = gitOk(['rev-parse', 'FETCH_HEAD'], b.repoTop);
  if (wt) {
    const ff = git(['merge', '--ff-only', fetched], wt, identityEnv(wt));
    if (ff.code !== 0) {
      throw new MergeError(
        `The cloud session's ${remoteBranch} doesn't fast-forward the local ${b.gitBranch}. Resolve it in ${wt}, then merge again.`,
      );
    }
  } else {
    gitOk(['branch', '-f', b.gitBranch, fetched], b.repoTop);
  }
}

function noteText(
  b: BranchRecord,
  strategy: MergeStrategy,
  files: string[],
  reason: string,
): string {
  const what = {
    commit: `was merged into your branch as a merge commit`,
    apply: `was applied to your working tree as uncommitted changes (nothing staged)`,
    defer: `is ready on branch ${b.gitBranch} but was NOT merged, because ${reason}. Merge it at a safe point with \`git merge ${b.gitBranch}\`, or ask the user to run \`pit merge ${b.name} --strategy commit\``,
    pr: `was pushed as ${b.gitBranch} for a pull request`,
    nothing: `finished without changes`,
  }[strategy];
  const files_ = files.length ? ` It changed ${files.join(', ')}.` : '';
  const advice =
    strategy === 'commit' || strategy === 'apply'
      ? ' Re-run the tests that cover these files, and do not revert these changes.'
      : '';
  return `While you worked, pitstop fork "${b.name}" (task: ${b.task}) ${what}.${files_}${advice}`;
}

/**
 * Bring a fork's work back. Runs under a per-repo lock so merges happen one
 * at a time, and each later merge is rebased onto what earlier ones brought in.
 */
export async function mergeBranch(
  cwd: string,
  name: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const ctx = repoContext(cwd);
  const cfg = loadConfig(ctx.top);
  return withLock(path.join(repoStateDir(ctx.repoId), 'merge.lock'), async () => {
    let b = loadBranch(ctx.repoId, name);
    if (!b) throw new MergeError(`No fork named "${name}"`);
    if (b.state === 'merged' || b.state === 'discarded')
      throw new MergeError(`Fork "${name}" is already ${b.state}`);
    const wt = b.worktree && fs.existsSync(b.worktree) ? b.worktree : undefined;
    if (!opts.force && b.sessionId) {
      const agent = (await listAgentsAsync()).find((a) => a.sessionId === b!.sessionId);
      if (isBusy(agent)) {
        throw new MergeError(
          `Fork "${name}" is still working. Wait for it to finish, or pass --force.`,
        );
      }
    }
    if (branchKind(b) === 'cloud') fetchCloudWork(b, wt, opts.fromBranch);
    if (wt) commitAll(wt, `pitstop: ${b.task}`);
    const parentDir = parentDirOf(b);
    const parentHead = head(parentDir);

    const forkHasChanges = revCount(ctx.top, `${b.snapshotCommit}..${b.gitBranch}`) > 0;
    let rebaseOk = true;
    if (forkHasChanges && wt) {
      const res = git(
        ['rebase', '--onto', parentHead, b.snapshotCommit, b.gitBranch],
        wt,
        identityEnv(wt),
      );
      if (res.code !== 0) {
        git(['rebase', '--abort'], wt);
        rebaseOk = false;
      }
    }
    const base = rebaseOk && wt ? parentHead : b.snapshotCommit;
    const files = forkHasChanges ? changedFiles(ctx.top, base, b.gitBranch) : [];
    const work = forkHasChanges ? workSummary(ctx.top, base, b.gitBranch) : {};

    const gateWanted = (b.testGate ?? cfg.testGate) && !!cfg.test && !opts.skipTests;
    let gate: GateResult | undefined;
    if (forkHasChanges && gateWanted && wt) {
      gate = await runTestGate(cfg.test!, wt, {
        PITSTOP_BRANCH: b.name,
        PITSTOP_PORT_OFFSET: String(b.portOffset),
      });
      if (!gate.ok) {
        b = saveBranch({
          ...b,
          note: `test gate failed (exit ${gate.code})`,
          gate: {
            ok: false,
            code: gate.code,
            durationMs: gate.durationMs,
            at: new Date().toISOString(),
          },
        });
        return {
          branch: b,
          strategy: 'blocked',
          reason: `\`${cfg.test}\` failed in the fork's worktree`,
          files,
          gate,
        };
      }
    }

    const dirty = dirtyFiles(parentDir);
    const patch = forkHasChanges
      ? git(['diff', '--binary', `${base}..${b.gitBranch}`], ctx.top).stdout
      : '';
    const applyCheckOk =
      !!patch &&
      runSync('git', ['apply', '--check', '-'], { cwd: parentDir, input: patch }).code === 0;
    const plan = opts.strategy
      ? { strategy: opts.strategy as MergeStrategy, reason: 'chosen with --strategy' }
      : planMerge({
          mode: cfg.merge.mode,
          forkHasChanges,
          rebaseOk,
          parentClean: isClean(parentDir),
          overlap: dirty.filter((f) => files.includes(f)),
          applyCheckOk,
        });

    let strategy = plan.strategy;
    let reason = plan.reason;
    if (strategy === 'commit') {
      const res = git(
        ['merge', '--no-ff', '-m', `pitstop: merge ${b.name}: ${b.task}`, b.gitBranch],
        parentDir,
        identityEnv(parentDir),
      );
      if (res.code !== 0) {
        git(['merge', '--abort'], parentDir);
        strategy = 'defer';
        reason = `git merge failed: ${(res.stderr || res.stdout).trim().split('\n')[0]}`;
      }
    } else if (strategy === 'apply') {
      const res = runSync('git', ['apply', '-'], { cwd: parentDir, input: patch });
      if (res.code !== 0) {
        strategy = 'defer';
        reason = `git apply failed: ${res.stderr.trim().split('\n')[0]}`;
      }
    } else if (strategy === 'pr') {
      const push = git(['push', '-u', 'origin', b.gitBranch], ctx.top);
      if (push.code !== 0) throw new MergeError(`git push failed: ${push.stderr.trim()}`);
      const pr = await run('gh', ['pr', 'create', '--fill', '--draft', '--head', b.gitBranch], {
        cwd: ctx.top,
      });
      reason =
        pr.code === 0
          ? pr.stdout.trim()
          : 'pushed; open the pull request on GitHub (gh CLI not available)';
    }

    if (strategy !== 'nothing') {
      sendInbox({
        to: b.parentSessionId,
        from: b.name,
        kind: strategy === 'commit' ? 'merged' : strategy === 'apply' ? 'applied' : 'deferred',
        text: noteText(b, strategy, files, reason),
        files,
      });
    }

    const finished =
      strategy === 'commit' || strategy === 'apply' || strategy === 'pr' || strategy === 'nothing';
    b = saveBranch({
      ...b,
      ...work,
      ...sessionFacts(b),
      gate: gate
        ? {
            ok: gate.ok,
            code: gate.code,
            durationMs: gate.durationMs,
            at: new Date().toISOString(),
          }
        : b.gate,
      state: finished ? 'merged' : 'deferred',
      mergedAt: finished ? new Date().toISOString() : undefined,
      mergeStrategy: strategy,
      note: reason,
    });
    if (finished && !opts.keep)
      cleanupFork(b, { deleteBranch: strategy === 'commit' || strategy === 'nothing' });
    return { branch: b, strategy, reason, files, gate };
  });
}

/** Stop the fork's session, remove its worktree and (optionally) its branch. Transcripts are kept. */
export function cleanupFork(b: BranchRecord, opts: { deleteBranch: boolean }): void {
  const id = b.shortId ?? b.sessionId;
  if (id) stopSession(id);
  if (b.worktree && fs.existsSync(b.worktree)) {
    const res = git(['worktree', 'remove', '--force', '--force', b.worktree], b.repoTop);
    if (res.code !== 0) worktreeRemove(b.repoTop, b.worktree, true);
  }
  git(['worktree', 'prune'], b.repoTop);
  if (id) removeSession(id);
  dropSnapshotRef(b.repoTop, b.snapshotRef);
  if (opts.deleteBranch) deleteBranch(b.repoTop, b.gitBranch, true);
  // A cloud fork's branch also lives on origin; the cloud session itself is left for the user.
  if (branchKind(b) === 'cloud') git(['push', 'origin', '--delete', b.gitBranch], b.repoTop);
}

export function discardBranch(cwd: string, name: string, keepBranch = false): BranchRecord {
  const ctx = repoContext(cwd);
  const b = loadBranch(ctx.repoId, name);
  if (!b) throw new MergeError(`No fork named "${name}"`);
  if (b.worktree && fs.existsSync(b.worktree))
    commitAll(b.worktree, `pitstop: ${b.task} (discarded)`);
  const facts = { ...workSummary(b.repoTop, b.snapshotCommit, b.gitBranch), ...sessionFacts(b) };
  cleanupFork(b, { deleteBranch: !keepBranch });
  return saveBranch({ ...b, ...facts, state: 'discarded' });
}

export type PullOutcome = 'ok' | 'needs-commit' | 'conflict' | 'no-worktree' | 'up-to-date';

/** Rebase a fork onto its parent's latest commits. */
export function pullFromParent(cwd: string, name: string): { outcome: PullOutcome; head?: string } {
  const ctx = repoContext(cwd);
  const b = loadBranch(ctx.repoId, name);
  if (!b) throw new MergeError(`No fork named "${name}"`);
  if (!b.worktree || !fs.existsSync(b.worktree)) return { outcome: 'no-worktree' };
  const parentHead = head(parentDirOf(b));
  if (git(['merge-base', '--is-ancestor', parentHead, 'HEAD'], b.worktree).code === 0) {
    return { outcome: 'up-to-date', head: parentHead };
  }
  if (!isClean(b.worktree)) {
    sendInbox({
      to: b.sessionId ?? b.parentSessionId,
      from: 'pitstop',
      kind: 'pull',
      text: "The user wants to bring in the main session's latest commits. Commit your current work in your worktree first, then say so; pitstop will rebase you.",
    });
    return { outcome: 'needs-commit' };
  }
  // --onto drops the snapshot commit itself, so the parent's old uncommitted work isn't replayed.
  const res = git(
    ['rebase', '--onto', parentHead, b.snapshotCommit, b.gitBranch],
    b.worktree,
    identityEnv(b.worktree),
  );
  if (res.code !== 0) {
    git(['rebase', '--abort'], b.worktree);
    return { outcome: 'conflict' };
  }
  // The fork's own work now starts at the parent's head.
  saveBranch({ ...b, snapshotCommit: parentHead });
  if (b.sessionId) {
    sendInbox({
      to: b.sessionId,
      from: 'pitstop',
      kind: 'pull',
      text: `Your worktree was rebased onto the main session's latest commit ${parentHead.slice(0, 8)}. Re-read files before editing them.`,
    });
  }
  return { outcome: 'ok', head: gitOk(['rev-parse', 'HEAD'], b.worktree) };
}
