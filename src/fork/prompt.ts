export const MARKER_RE = /\[pitstop:([a-z0-9][a-z0-9-]*) parent=([0-9a-f-]{8,})\]/;

export function marker(name: string, parentSessionId: string): string {
  return `[pitstop:${name} parent=${parentSessionId}]`;
}

export function parseMarker(text: string): { name: string; parent: string } | undefined {
  const m = MARKER_RE.exec(text);
  return m && m[1] && m[2] ? { name: m[1], parent: m[2] } : undefined;
}

export interface ForkPromptOptions {
  name: string;
  task: string;
  parentSessionId: string;
  parentName: string;
  repoTop: string;
  portOffset: number;
  mergeMode: 'local' | 'pr';
  /** Tool calls the parent still had running when the fork was made. */
  pending?: string[];
}

/** First message of every fork: who it is, what its one job is, and how to hand back. */
export function forkPrompt(o: ForkPromptOptions): string {
  const lines = [
    `${marker(o.name, o.parentSessionId)} You are pitstop fork "${o.name}" of the session "${o.parentName}". You have its full conversation above. That session is still running in ${o.repoTop}; do not continue its work.`,
    '',
    `Your only task: ${o.task}`,
    '',
    'Rules:',
    '- Call EnterWorktree before you edit files or run commands that change files or git state. Work only inside that worktree; never edit or run git commands in the main checkout.',
    `- Use PITSTOP_PORT_OFFSET (${o.portOffset}) for any dev server, test server or database port so you don't collide with the main session.`,
    '- When the task is done, commit your changes in the worktree with a clear message.',
    o.mergeMode === 'pr'
      ? '- Then push your branch and open a draft pull request.'
      : '- Do not push or open a pull request. pitstop merges your branch locally.',
    `- Finally use SendMessage to send "${o.parentName}" a handoff of 10 lines or less: what you changed, which files, and which tests to re-run. Then stop.`,
  ];
  if (o.pending?.length) {
    lines.push(
      '',
      `When you were forked, the main session was still running: ${o.pending.join('; ')}. That is its job. Do not run it again.`,
    );
  }
  return lines.join('\n');
}

/** Reminder injected at session start, in case the fork prompt has scrolled out of focus. */
export function forkReminder(name: string, worktree: string | undefined, repoTop: string): string {
  return [
    `pitstop: you are fork "${name}".`,
    worktree
      ? `Work only inside your worktree ${worktree}.`
      : 'Call EnterWorktree before changing files or git state.',
    `The main session is still working in ${repoTop}; don't edit files there.`,
  ].join(' ');
}

export interface SummaryForkPromptOptions {
  kind: 'cloud' | 'agent';
  name: string;
  task: string;
  parentName: string;
  /** Condensed conversation of the parent (see claude/digest.ts). */
  digest: string;
  gitBranch: string;
  portOffset: number;
  mergeMode: 'local' | 'pr';
}

/**
 * First message for forks that can't load the parent's transcript: a cloud
 * session or another agent. They get a summary, their one task, and how to
 * hand the work back.
 */
export function summaryForkPrompt(o: SummaryForkPromptOptions): string {
  const rules =
    o.kind === 'cloud'
      ? [
          `- You are on branch ${o.gitBranch}. When the task is done, commit and push your work to ${o.gitBranch}.`,
          o.mergeMode === 'pr'
            ? '- Then open a draft pull request.'
            : '- Do not open a pull request. pitstop merges the branch locally.',
          `- If pushing to ${o.gitBranch} is refused, push to any branch you can and end your last message with: BRANCH: <that branch>`,
        ]
      : [
          `- Work only in this directory (a git worktree on branch ${o.gitBranch}). Another session is working in the main checkout; don't touch it.`,
          `- Use PITSTOP_PORT_OFFSET (${o.portOffset}) for any dev server, test server or database port.`,
          '- When the task is done, commit your changes here with a clear message, then stop.',
          '- Do not push or open a pull request. pitstop merges your branch locally.',
        ];
  return [
    `You are pitstop fork "${o.name}", started from the Claude Code session "${o.parentName}" while it keeps working. Below is a summary of that conversation so you have its context. Do not continue its work.`,
    '',
    `Your only task: ${o.task}`,
    '',
    'Rules:',
    ...rules,
    '',
    '----- conversation summary -----',
    o.digest,
    '----- end of summary -----',
    '',
    `Your only task: ${o.task}`,
  ].join('\n');
}
