import fs from 'node:fs';
import path from 'node:path';
import { branchKind, LIVE_STATES, listBranches, type BranchRecord } from './branches.js';
import { listAgentsAsync, type AgentInfo } from './claude/agents.js';
import { branchExists, dirtyFiles, repoContext } from './core/git.js';
import { pitstopHome } from './core/paths.js';
import { writeFileAtomic } from './core/store.js';
import { sanitizeForContext } from './inbox.js';
import { workSummary } from './merge/merge.js';
import { collectTouched, findOverlaps, type Overlap } from './radar.js';
import { sessionCost, sessionState, treeLines, type CostInfo } from './status.js';

export interface ReportFork {
  branch: BranchRecord;
  state: string;
  commits: string[];
  diffstat: string;
  files: string[];
  /** Uncommitted files in a live fork's worktree. */
  uncommitted: string[];
  costUsd?: number;
  lastMessage?: string;
}

export interface ReportInput {
  repoName: string;
  generatedAt: Date;
  tree: string[];
  forks: ReportFork[];
  overlaps: Overlap[];
}

/** Collect everything the report shows. Live forks are read from git now; finished ones from what merge saved. */
export async function buildReport(
  cwd: string,
  opts: { all?: boolean; mainLabel?: string; mainSessionId?: string } = {},
): Promise<ReportInput> {
  const ctx = repoContext(cwd);
  const agents: AgentInfo[] = await listAgentsAsync();
  const branches = listBranches(ctx.repoId).filter(
    (b) => opts.all !== false || LIVE_STATES.includes(b.state),
  );
  const touched = await collectTouched(ctx.top, branches);
  const costs = new Map<string, CostInfo>();
  const forks: ReportFork[] = branches.map((b) => {
    const live = LIVE_STATES.includes(b.state);
    const work =
      live && branchExists(ctx.top, b.gitBranch)
        ? workSummary(ctx.top, b.snapshotCommit, b.gitBranch)
        : {};
    const cost = live && b.sessionId ? sessionCost(b.sessionId) : undefined;
    if (cost && b.sessionId) costs.set(b.sessionId, cost);
    return {
      branch: b,
      state: sessionState(
        b.sessionId ? agents.find((a) => a.sessionId === b.sessionId) : undefined,
        b,
      ),
      commits: work.commits ?? b.commits ?? [],
      diffstat: work.diffstat ?? b.diffstat ?? '',
      files: work.filesChanged ?? b.filesChanged ?? [],
      uncommitted: live && b.worktree && fs.existsSync(b.worktree) ? dirtyFiles(b.worktree) : [],
      costUsd: cost?.usd ?? b.costUsd,
      lastMessage: cost?.last ?? b.lastMessage,
    };
  });
  const overlaps = findOverlaps(touched);
  return {
    repoName: ctx.name,
    generatedAt: new Date(),
    tree: treeLines({
      mainLabel: `${opts.mainLabel ?? 'main session'} (main)`,
      mainSessionId: opts.mainSessionId,
      branches,
      agents,
      costs,
      touched,
      overlaps,
      all: true,
    }),
    forks,
    overlaps,
  };
}

// ---- rendering --------------------------------------------------------------

function runsOn(b: BranchRecord): string {
  switch (branchKind(b)) {
    case 'cloud':
      return `Claude cloud session${b.cloudUrl ? ` (${b.cloudUrl})` : ''}, started from a summary`;
    case 'agent':
      return `${b.agent ?? 'another agent'}, started from a summary of the conversation`;
    default:
      return b.forkMethod === 'sealed'
        ? 'Claude, sealed copy of the full conversation (the parent was mid-turn)'
        : 'Claude, native fork with the full conversation';
  }
}

function gateText(b: BranchRecord): string {
  if (!b.gate) return 'not run';
  const secs = Math.round(b.gate.durationMs / 1000);
  return b.gate.ok ? `passed (${secs}s)` : `failed (exit ${b.gate.code}, ${secs}s)`;
}

function result(f: ReportFork): string {
  const b = f.branch;
  if (b.state === 'merged')
    return `merged: ${b.mergeStrategy ?? 'commit'}${b.note ? `, ${b.note}` : ''}`;
  if (b.state === 'deferred') return `ready, not merged: ${b.note ?? ''}`;
  if (b.state === 'discarded') return 'deleted';
  if (b.state === 'failed') return `failed: ${b.note ?? ''}`;
  return `${f.state}${f.uncommitted.length ? `, ${f.uncommitted.length} uncommitted file${f.uncommitted.length === 1 ? '' : 's'}` : ''}`;
}

const clean = (s: string, max = 600) => sanitizeForContext(s, max, false);
const cell = (s: string) => clean(s, 400).replace(/\|/g, '\\|');

function summaryLine(forks: ReportFork[]): string {
  const count = (pred: (f: ReportFork) => boolean) => forks.filter(pred).length;
  const merged = count((f) => f.branch.state === 'merged');
  const live = count((f) => LIVE_STATES.includes(f.branch.state));
  const deleted = count((f) => f.branch.state === 'discarded');
  return `${forks.length} fork${forks.length === 1 ? '' : 's'}: ${merged} merged, ${live} live, ${deleted} deleted`;
}

/** Markdown for a PR description or a chat message. */
export function renderReportMarkdown(r: ReportInput): string {
  const out = [
    `# pitstop report: ${clean(r.repoName)}`,
    '',
    `_Generated ${r.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC · ${summaryLine(r.forks)}_`,
    '',
    '## Branch tree',
    '',
    '```text',
    ...r.tree.map((l) => clean(l, 300)),
    '```',
  ];
  if (r.forks.length) out.push('', '## Forks');
  for (const f of r.forks) {
    const b = f.branch;
    out.push(
      '',
      `### ${clean(b.name)}`,
      '',
      '| | |',
      '|---|---|',
      `| Task | ${cell(b.task)} |`,
      `| Runs on | ${cell(runsOn(b))} |`,
      `| Forked from | ${cell(b.parentBranch ?? b.parentSessionName ?? 'main')} |`,
      `| Result | ${cell(result(f))} |`,
      `| Test gate | ${gateText(b)} |`,
      `| Estimated cost | ${f.costUsd !== undefined ? `$${f.costUsd.toFixed(2)}` : branchKind(b) === 'claude' ? 'unknown' : 'not tracked'} |`,
      `| Branch | \`${b.gitBranch}\` |`,
    );
    if (b.pendingAtFork?.length)
      out.push(`| Parent was running | ${cell(b.pendingAtFork.join('; '))} |`);
    if (f.commits.length)
      out.push('', '**Commits**', '', ...f.commits.slice(0, 30).map((c) => `- ${clean(c, 200)}`));
    if (f.diffstat)
      out.push(
        '',
        '**Changes**',
        '',
        '```text',
        ...f.diffstat
          .split('\n')
          .slice(-40)
          .map((l) => clean(l, 200)),
        '```',
      );
    if (f.lastMessage) {
      out.push(
        '',
        '**Handoff (last message from the fork)**',
        '',
        ...clean(f.lastMessage, 1500)
          .split(/(?<=\.)\s+/)
          .map((l) => `> ${l}`),
      );
    }
  }
  if (r.overlaps.length) {
    out.push('', '## Files changed by more than one session', '');
    for (const o of r.overlaps)
      out.push(`- \`${clean(o.file, 200)}\`: ${o.sessions.map((s) => clean(s, 60)).join(', ')}`);
  }
  out.push('', '<sub>Made with pitstop</sub>', '');
  return out.join('\n');
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained page (inline styles, no external assets) to attach or send. */
export function renderReportHtml(r: ReportInput): string {
  const forkHtml = r.forks
    .map((f) => {
      const b = f.branch;
      const rows: [string, string][] = [
        ['Task', b.task],
        ['Runs on', runsOn(b)],
        ['Forked from', b.parentBranch ?? b.parentSessionName ?? 'main'],
        ['Result', result(f)],
        ['Test gate', gateText(b)],
        ['Estimated cost', f.costUsd !== undefined ? `$${f.costUsd.toFixed(2)}` : 'not tracked'],
        ['Branch', b.gitBranch],
      ];
      return `<section class="fork">
  <h3>${esc(b.name)} <span class="state s-${esc(b.state)}">${esc(b.state)}</span></h3>
  <table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
  ${
    f.commits.length
      ? `<h4>Commits</h4><ul>${f.commits
          .slice(0, 30)
          .map((c) => `<li><code>${esc(c)}</code></li>`)
          .join('')}</ul>`
      : ''
  }
  ${f.diffstat ? `<h4>Changes</h4><pre>${esc(f.diffstat)}</pre>` : ''}
  ${f.lastMessage ? `<h4>Handoff</h4><blockquote>${esc(f.lastMessage.slice(0, 1500))}</blockquote>` : ''}
</section>`;
    })
    .join('\n');
  const overlaps = r.overlaps.length
    ? `<h2>Files changed by more than one session</h2><ul>${r.overlaps.map((o) => `<li><code>${esc(o.file)}</code>: ${esc(o.sessions.join(', '))}</li>`).join('')}</ul>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>pitstop report · ${esc(r.repoName)}</title>
<style>
:root{--bg:#f6f7f6;--fg:#1b1f22;--muted:#5a6369;--line:#d3d8da;--card:#fff;--accent:#b8730a}
@media (prefers-color-scheme:dark){:root{--bg:#121517;--fg:#e5e8e9;--muted:#98a1a7;--line:#343c41;--card:#1a1e21;--accent:#e3a33b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 16px}
h1{margin:0 0 4px;font-size:28px}h2{margin-top:32px;font-size:20px}h3{margin:0 0 10px;font-size:17px}h4{margin:14px 0 6px;font-size:14px;color:var(--muted)}
.sub{color:var(--muted);margin:0}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font:12.5px/1.5 ui-monospace,Menlo,monospace}
.fork{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:14px 0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{width:150px;color:var(--muted);font-weight:500}
.state{font-size:12px;border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:1px 8px;margin-left:6px;vertical-align:middle}
blockquote{margin:0;padding:8px 12px;border-left:3px solid var(--accent);color:var(--fg);background:var(--bg);white-space:pre-wrap}
ul{padding-left:20px}code{font:12.5px ui-monospace,Menlo,monospace}
</style></head>
<body><main>
<h1>pitstop report · ${esc(r.repoName)}</h1>
<p class="sub">Generated ${esc(r.generatedAt.toISOString().replace('T', ' ').slice(0, 16))} UTC · ${esc(summaryLine(r.forks))}</p>
<h2>Branch tree</h2>
<pre>${esc(r.tree.join('\n'))}</pre>
${r.forks.length ? `<h2>Forks</h2>\n${forkHtml}` : ''}
${overlaps}
</main></body></html>
`;
}

/** Write the report and return where it went. `out` of "-" means the caller prints it. */
export function writeReport(r: ReportInput, opts: { html?: boolean; out?: string } = {}): string {
  const content = opts.html ? renderReportHtml(r) : renderReportMarkdown(r);
  const stamp = r.generatedAt.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file =
    opts.out ??
    path.join(pitstopHome(), 'reports', `${r.repoName}-${stamp}.${opts.html ? 'html' : 'md'}`);
  writeFileAtomic(file, content, 0o644);
  return file;
}
