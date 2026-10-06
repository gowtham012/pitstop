import { run, runSync, type RunResult } from '../core/exec.js';

/** One row of `claude agents --json`. Fields vary by Claude Code version, so all but sessionId are optional. */
export interface AgentInfo {
  sessionId: string;
  id?: string;
  pid?: number;
  cwd?: string;
  kind?: 'interactive' | 'background' | string;
  startedAt?: number;
  name?: string;
  status?: 'busy' | 'idle' | 'waiting' | string;
  state?: 'working' | 'blocked' | 'done' | string;
  waitingFor?: string;
  [key: string]: unknown;
}

export class ClaudeError extends Error {}

export class WorkspaceTrustError extends ClaudeError {
  constructor(public readonly cwd: string) {
    super(
      `Claude Code hasn't been told to trust ${cwd} yet. Run \`claude\` there once, accept the trust prompt, then start pit again.`,
    );
  }
}

export function claudeBin(): string {
  return process.env.PITSTOP_CLAUDE_BIN ?? 'claude';
}

export function parseAgents(json: string): AgentInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.filter(
    (a): a is AgentInfo =>
      !!a && typeof a === 'object' && typeof (a as AgentInfo).sessionId === 'string',
  );
}

export function listAgents(all = false): AgentInfo[] {
  const res = runSync(claudeBin(), ['agents', '--json', ...(all ? ['--all'] : [])], {
    timeoutMs: 20_000,
  });
  return res.code === 0 ? parseAgents(res.stdout) : [];
}

export async function listAgentsAsync(all = false): Promise<AgentInfo[]> {
  const res = await run(claudeBin(), ['agents', '--json', ...(all ? ['--all'] : [])], {
    timeoutMs: 20_000,
  });
  return res.code === 0 ? parseAgents(res.stdout) : [];
}

/**
 * True when the session is mid-turn: running a tool, or waiting on a permission
 * prompt for one. A native fork of such a session re-runs the pending call.
 */
export function isBusy(agent: AgentInfo | undefined): boolean {
  if (!agent) return false;
  if (agent.status) return agent.status === 'busy' || agent.status === 'waiting';
  return agent.state === 'working';
}

/** Parse `backgrounded · 651b085b · my-name` from `claude --bg` output. */
export function parseBackgrounded(out: string): { shortId: string; name: string } | undefined {
  const m = /backgrounded\s*·\s*([0-9a-f]{6,})\s*·\s*([^\n(]+?)\s*(?:\(|$)/m.exec(out);
  if (!m || !m[1] || !m[2]) return undefined;
  return { shortId: m[1], name: m[2].trim() };
}

export interface BackgroundLaunch {
  cwd: string;
  name: string;
  prompt?: string;
  /** Session to copy. Always paired with --fork-session unless `continueSession` is set. */
  resume?: string;
  /** Continue `resume` under its own id instead of copying it (used for sealed copies). */
  continueSession?: boolean;
  settings?: Record<string, unknown>;
  model?: string;
  effort?: string;
  permissionMode?: string;
  extraArgs?: string[];
}

/**
 * Build argv for `claude --bg`. Never uses variadic flags such as
 * --allowedTools: they swallow the prompt that follows (see docs/spike.md).
 * Permissions and hooks travel inside --settings instead, and the prompt is last.
 */
export function backgroundArgs(l: BackgroundLaunch): string[] {
  const args = ['--bg', '-n', l.name];
  if (l.resume) {
    args.push('--resume', l.resume);
    if (!l.continueSession) args.push('--fork-session');
  }
  if (l.model) args.push('--model', l.model);
  if (l.effort) args.push('--effort', l.effort);
  if (l.permissionMode) args.push('--permission-mode', l.permissionMode);
  if (l.settings) args.push('--settings', JSON.stringify(l.settings));
  if (l.extraArgs) args.push(...l.extraArgs);
  if (l.prompt) args.push(l.prompt.startsWith('-') ? ` ${l.prompt}` : l.prompt);
  return args;
}

export interface LaunchedSession {
  shortId: string;
  sessionId: string;
  name: string;
  output: string;
}

export async function startBackground(l: BackgroundLaunch): Promise<LaunchedSession> {
  const res: RunResult = await run(claudeBin(), backgroundArgs(l), {
    cwd: l.cwd,
    timeoutMs: 120_000,
  });
  const output = `${res.stdout}\n${res.stderr}`;
  if (/workspace not trusted/i.test(output)) throw new WorkspaceTrustError(l.cwd);
  const parsed = parseBackgrounded(output);
  if (!parsed) throw new ClaudeError(`claude --bg did not start a session:\n${output.trim()}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const agent = (await listAgentsAsync(true)).find(
      (a) => a.id === parsed.shortId || a.sessionId.startsWith(parsed.shortId),
    );
    if (agent)
      return { shortId: parsed.shortId, sessionId: agent.sessionId, name: parsed.name, output };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new ClaudeError(
    `Started ${parsed.shortId} but it never appeared in \`claude agents --json\``,
  );
}

export function stopSession(id: string): RunResult {
  return runSync(claudeBin(), ['stop', id], { timeoutMs: 30_000 });
}

export function removeSession(id: string): RunResult {
  return runSync(claudeBin(), ['rm', id], { timeoutMs: 30_000 });
}
