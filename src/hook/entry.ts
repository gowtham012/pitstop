/**
 * pitstop's hook. Claude Code runs it for every session pitstop starts
 * (hooks are passed per session through --settings), with the event JSON
 * on stdin. It must be fast and must never break the session: any failure
 * is logged and the hook exits 0 with no decision.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  branchForSession,
  listBranches,
  loadSession,
  saveBranch,
  upsertSession,
  type BranchRecord,
} from '../branches.js';
import { loadConfig } from '../core/config.js';
import { repoContext } from '../core/git.js';
import { inboxDir, logsDir } from '../core/paths.js';
import { dropSnapshotRef } from '../core/snapshot.js';
import { readTranscriptSnapshot } from '../claude/transcript.js';
import { forkReminder, parseMarker } from '../fork/prompt.js';
import { createForkWorktree, createPlainWorktree } from '../fork/worktree.js';
import { claimInbox, formatInbox } from '../inbox.js';
import { guardDecision } from './guard.js';

export interface HookInput {
  session_id: string;
  hook_event_name?: string;
  cwd?: string;
  transcript_path?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  name?: string;
  [key: string]: unknown;
}

export interface HookOutput {
  stdout?: string;
  exitCode: number;
}

function json(event: string, fields: Record<string, unknown>): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } });
}

/**
 * Find the fork's branch by session id, falling back to the pitstop marker in
 * its latest prompt. A fork of a fork carries its parent's marker in its
 * history too, so a branch already bound to another session is never taken,
 * and SessionStart (which can run before the new prompt is recorded) never
 * reads the transcript.
 */
export function resolveBranch(input: HookInput, allowTranscript = true): BranchRecord | undefined {
  const known = branchForSession(input.session_id);
  if (known) return known;
  const text = input.prompt ?? (allowTranscript ? latestMarkedPrompt(input.transcript_path) : undefined);
  const m = text ? parseMarker(text) : undefined;
  if (!m || !input.cwd) return undefined;
  let repoId: string;
  try {
    repoId = repoContext(input.cwd).repoId;
  } catch {
    return undefined;
  }
  const branch = listBranches(repoId).find((b) => b.name === m.name);
  if (!branch || (branch.sessionId && branch.sessionId !== input.session_id)) return undefined;
  upsertSession({ sessionId: input.session_id, role: 'fork', repoId, branch: branch.name });
  if (!branch.sessionId) saveBranch({ ...branch, sessionId: input.session_id });
  return branch;
}

function latestMarkedPrompt(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return undefined;
  const records = readTranscriptSnapshot(transcriptPath);
  for (let i = records.length - 1; i >= 0; i--) {
    const c = records[i]?.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? '').join(' ') : '';
    if (parseMarker(text)) return text;
  }
  return undefined;
}

function deliver(event: string, sessionId: string, extra?: string): HookOutput {
  const msgs = claimInbox(sessionId);
  const parts = [extra, msgs.length ? formatInbox(msgs) : undefined].filter(Boolean);
  if (!parts.length) return { exitCode: 0 };
  return { exitCode: 0, stdout: json(event, { additionalContext: parts.join('\n\n') }) };
}

export function handleHook(event: string, input: HookInput): HookOutput {
  const sid = input.session_id;
  switch (event) {
    case 'PostToolUse':
      // Hot path: runs after every tool call. One stat when the inbox is empty.
      if (!fs.existsSync(inboxDir(sid))) return { exitCode: 0 };
      return deliver(event, sid);

    case 'SessionStart': {
      upsertSession({
        sessionId: sid,
        cwd: input.cwd,
        transcriptPath: input.transcript_path,
        startedAt: new Date().toISOString(),
        ...(loadSession(sid) ? {} : { role: 'fork' as const }),
      });
      const branch = resolveBranch(input, false);
      const reminder = branch ? forkReminder(branch.name, branch.worktree, branch.repoTop) : undefined;
      return deliver(event, sid, reminder);
    }

    case 'UserPromptSubmit': {
      upsertSession({ sessionId: sid, lastPromptAt: new Date().toISOString() });
      resolveBranch(input);
      return deliver(event, sid);
    }

    case 'PreToolUse': {
      const branch = resolveBranch(input);
      if (!branch || !input.tool_name) return { exitCode: 0 };
      const d = guardDecision({
        toolName: input.tool_name,
        toolInput: input.tool_input ?? {},
        cwd: input.cwd ?? branch.repoTop,
        worktree: branch.worktree,
        repoTop: branch.repoTop,
      });
      if (!d.deny) return { exitCode: 0 };
      return {
        exitCode: 0,
        stdout: json(event, { permissionDecision: 'deny', permissionDecisionReason: d.reason }),
      };
    }

    case 'WorktreeCreate': {
      const branch = resolveBranch(input);
      if (branch) {
        const dir = createForkWorktree(branch, loadConfig(branch.repoTop).setup);
        dropSnapshotRef(branch.repoTop, branch.snapshotRef);
        saveBranch({ ...branch, worktree: dir, snapshotRef: undefined, state: 'running' });
        return { exitCode: 0, stdout: dir };
      }
      const name = input.name ?? sid.slice(0, 8);
      return { exitCode: 0, stdout: createPlainWorktree(input.cwd ?? process.cwd(), name) };
    }

    case 'SessionEnd':
      upsertSession({ sessionId: sid, endedAt: new Date().toISOString() });
      return { exitCode: 0 };

    default:
      return { exitCode: 0 };
  }
}

function logError(event: string, err: unknown): void {
  try {
    fs.mkdirSync(logsDir(), { recursive: true });
    fs.appendFileSync(
      path.join(logsDir(), 'hook-errors.log'),
      `${new Date().toISOString()} ${event} ${err instanceof Error ? err.stack : String(err)}\n`,
    );
  } catch {
    // nothing else we can do
  }
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  let input: HookInput;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
  } catch {
    process.exit(0);
  }
  const event = process.argv[2] ?? input.hook_event_name ?? '';
  try {
    const out = handleHook(event, input);
    if (out.stdout) process.stdout.write(out.stdout + '\n');
    process.exit(out.exitCode);
  } catch (err) {
    logError(event, err);
    // WorktreeCreate needs a path or creation fails; every other event fails open.
    process.exit(event === 'WorktreeCreate' ? 1 : 0);
  }
}

if (process.argv[1] && /hook\.(js|ts)$/.test(process.argv[1])) void main();
