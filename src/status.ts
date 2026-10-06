import { LIVE_STATES, type BranchRecord } from './branches.js';
import type { AgentInfo } from './claude/agents.js';
import { findTranscript } from './claude/locate.js';
import {
  estimateCostUsd,
  lastAssistantText,
  readTranscriptSnapshot,
  sumUsage,
} from './claude/transcript.js';
import type { Overlap } from './radar.js';

export type SessionState = 'working' | 'needs input' | 'idle' | 'stopped' | BranchRecord['state'];

/** One word for where a session is, combining Claude Code's live status with pitstop's branch state. */
export function sessionState(agent: AgentInfo | undefined, branch?: BranchRecord): SessionState {
  if (branch && !['starting', 'running', 'idle', 'done'].includes(branch.state))
    return branch.state;
  if (!agent) return branch?.state === 'starting' ? 'starting' : 'stopped';
  if (agent.status === 'busy') return 'working';
  if (agent.status === 'waiting') return 'needs input';
  if (agent.state === 'working') return 'working';
  if (agent.state === 'blocked') return 'needs input';
  return 'idle';
}

export function stateGlyph(s: SessionState): string {
  switch (s) {
    case 'working':
    case 'running':
    case 'starting':
      return '●';
    case 'needs input':
      return '?';
    case 'merged':
      return '✓';
    case 'failed':
      return '✗';
    case 'deferred':
      return '↺';
    case 'discarded':
    case 'stopped':
      return '○';
    default:
      return '·';
  }
}

export interface CostInfo {
  usd: number;
  last?: string;
}

/** Estimated spend and last message of a session, read from its transcript. */
export function sessionCost(sessionId: string): CostInfo | undefined {
  const file = findTranscript(sessionId);
  if (!file) return undefined;
  try {
    const records = readTranscriptSnapshot(file);
    return { usd: estimateCostUsd(sumUsage(records)), last: lastAssistantText(records) };
  } catch {
    return undefined;
  }
}

export interface TreeInput {
  mainLabel: string;
  mainSessionId?: string;
  branches: BranchRecord[];
  agents: AgentInfo[];
  costs?: Map<string, CostInfo>;
  touched?: Map<string, string[]>;
  overlaps?: Overlap[];
  /** Include merged and discarded forks. */
  all?: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** `git log --graph`-style lines: main session, then forks nested under the session they came from. */
export function treeLines(t: TreeInput): string[] {
  const agentOf = (id?: string) => (id ? t.agents.find((a) => a.sessionId === id) : undefined);
  const shown = t.branches.filter((b) => t.all || LIVE_STATES.includes(b.state));
  const mainAgent = agentOf(t.mainSessionId);
  const mainCost = t.mainSessionId ? t.costs?.get(t.mainSessionId) : undefined;
  const lines = [
    `${t.mainLabel}  ${sessionState(mainAgent)}${mainCost ? `  $${mainCost.usd.toFixed(2)} est` : ''}`,
  ];
  const children = (parent: string | undefined) =>
    shown.filter((b) =>
      parent
        ? b.parentBranch === parent
        : !b.parentBranch || !shown.some((p) => p.name === b.parentBranch),
    );
  const walk = (parent: string | undefined, prefix: string) => {
    const kids = children(parent);
    kids.forEach((b, i) => {
      const last = i === kids.length - 1;
      const state = sessionState(agentOf(b.sessionId), b);
      const files = t.touched?.get(b.name);
      const cost = b.sessionId ? t.costs?.get(b.sessionId) : undefined;
      const flags = t.overlaps?.some((o) => o.sessions.includes(b.name)) ? '  !! overlap' : '';
      lines.push(
        `${prefix}${last ? '└─ ' : '├─ '}${pad(b.name, 18)} ${pad(`${stateGlyph(state)} ${state}`, 14)} ${pad(b.mode, 4)} ${pad(b.forkMethod, 6)}` +
          `${files ? ` ${files.length} file${files.length === 1 ? '' : 's'}` : ''}${cost ? `  $${cost.usd.toFixed(2)} est` : ''}${flags}`,
      );
      walk(b.name, `${prefix}${last ? '   ' : '│  '}`);
    });
  };
  walk(undefined, '');
  if (lines.length === 1)
    lines.push('   (no forks yet: press ctrl+\\ f, or run `pit fork "task"`)');
  return lines;
}
