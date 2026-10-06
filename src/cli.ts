import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import {
  listBranches,
  loadBranch,
  saveBranch,
  type BranchRecord,
  type SessionRecord,
} from './branches.js';
import { claudeBin, findAgent, listAgentsAsync, type AgentInfo } from './claude/agents.js';
import {
  loadConfig,
  readRepoConfig,
  repoCommands,
  repoCommandsTrusted,
  trustRepoCommands,
} from './core/config.js';
import { runSync } from './core/exec.js';
import { git, isGitRepo, repoContext } from './core/git.js';
import { sessionsDir } from './core/paths.js';
import { listJson } from './core/store.js';
import { originUrl } from './fork/cloud.js';
import { recordAgentConsent } from './fork/common.js';
import { ConfirmationNeeded, forkSession, type ForkRequest } from './fork/fork.js';
import { buildReport, renderReportHtml, renderReportMarkdown, writeReport } from './report.js';
import { tuiRunning } from './tui/presence.js';
import { installKind, loadState, packageRoot, upgrade } from './upgrade.js';
import { loadPty } from './tui/pty.js';
import {
  clearHistory,
  deleteFork,
  finishedForks,
  mergeBranch,
  pullFromParent,
  type DeleteResult,
  type MergeOptions,
} from './merge/merge.js';
import { collectTouched, findOverlaps } from './radar.js';
import { sessionCost, sessionState, treeLines, type CostInfo } from './status.js';
import { VERSION } from './version.js';

const SUBCOMMANDS = new Set([
  'report',
  'fork',
  'merge',
  'diff',
  'pull',
  'tree',
  'status',
  'log',
  'delete',
  'rm',
  'discard',
  'trust',
  'doctor',
  'upgrade',
  'help',
]);

function fail(message: string): never {
  process.stderr.write(`pit: ${message}\n`);
  process.exit(1);
}

function requireRepo(): ReturnType<typeof repoContext> {
  if (!isGitRepo(process.cwd())) fail('run pit inside a git repository');
  return repoContext(process.cwd());
}

/** The repo's main session: the one pit started, else the only live session working in this repo. */
async function findMainSession(
  repoId: string,
  repoTop: string,
  agents: AgentInfo[],
): Promise<AgentInfo | undefined> {
  const mains = listJson<SessionRecord>(sessionsDir()).filter(
    (s) => s.role === 'main' && s.repoId === repoId,
  );
  for (const m of mains) {
    const a = findAgent(agents, m.sessionId);
    if (a) return a;
  }
  const forkIds = new Set(listBranches(repoId).map((b) => b.sessionId));
  const here = agents.filter(
    (a) =>
      a.cwd && (a.cwd === repoTop || a.cwd.startsWith(`${repoTop}/`)) && !forkIds.has(a.sessionId),
  );
  return here.length === 1 ? here[0] : undefined;
}

async function costsFor(ids: (string | undefined)[]): Promise<Map<string, CostInfo>> {
  const m = new Map<string, CostInfo>();
  for (const id of ids) {
    if (!id) continue;
    const c = sessionCost(id);
    if (c) m.set(id, c);
  }
  return m;
}

async function runTui(argv: string[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      'pit needs an interactive terminal. In scripts use `pit fork`, `pit merge` or `pit tree`.',
    );
  }
  const ctx = requireRepo();
  let mainSessionId: string | undefined;
  const claudeArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--main') mainSessionId = argv[++i];
    else claudeArgs.push(argv[i]!);
  }
  const { App } = await import('./tui/app.js');
  const app = new App({ cwd: ctx.top, claudeArgs, mainSessionId });
  await app.run();
  process.exit(0); // the UI is torn down; don't wait on pending timers or child pipes
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Fork, asking on the terminal when the fork would push to GitHub or send a summary elsewhere. */
async function forkWithConsent(req: ForkRequest, yes: boolean): Promise<BranchRecord> {
  try {
    return await forkSession({ ...req, confirmed: yes });
  } catch (err) {
    if (!(err instanceof ConfirmationNeeded)) throw err;
    process.stdout.write(`${err.message}\n`);
    if (!(await askYesNo('Continue?'))) fail('not started (pass --yes to skip this question)');
    const ctx = repoContext(req.cwd);
    const agent =
      req.agent ?? (req.preset ? loadConfig(ctx.top).presets[req.preset]?.agent : undefined);
    if (err.what === 'agent' && agent) recordAgentConsent(ctx.repoId, agent);
    return forkSession({ ...req, confirmed: true });
  }
}

/** With no `pit` UI open, run a cloud or agent fork's program right here in this terminal. */
function runLaunchHere(b: BranchRecord): void {
  if (!b.launch) return;
  saveBranch({ ...b, state: 'running' });
  const res = spawnSync(b.launch.cmd, b.launch.args, {
    cwd: b.launch.cwd,
    env: { ...process.env, ...b.launch.env },
    stdio: 'inherit',
  });
  if (res.error) fail(`could not start ${b.launch.cmd}: ${res.error.message}`);
  if (b.kind === 'agent') {
    const cur = loadBranch(b.repoId, b.name);
    if (cur) saveBranch({ ...cur, state: 'idle' });
  }
}

function buildProgram(): Command {
  const program = new Command('pit')
    .description(
      'Fork a running Claude Code session into a split pane with its full context, run urgent tasks side by side, and merge code and knowledge back.\n\nRun `pit` with no command to open the split-pane UI (any extra flags go to claude).',
    )
    .version(VERSION, '-V, --version');

  program
    .command('fork')
    .description('fork the main session (or --parent) with its full conversation')
    .argument('<task...>', 'what the fork should do')
    .option('--bg', 'run with no pane; merge it when it is done')
    .option('--preset <name>', 'fork recipe from config (e.g. hotfix)')
    .option('--name <name>', 'branch name (default: from the task)')
    .option('--parent <session>', 'session id to fork instead of the main session')
    .option('--native', "always use Claude Code's own fork, even mid-turn")
    .option('--sealed', 'always use a sealed copy')
    .option('--cloud', 'run as a Claude cloud session (pushes the starting point to origin)')
    .option('--agent <name>', 'run with another agent from config, e.g. codex or gemini')
    .option('--yes', "don't ask before pushing (cloud) or sending a summary (agent)")
    .action(
      async (
        task: string[],
        o: {
          bg?: boolean;
          preset?: string;
          name?: string;
          parent?: string;
          native?: boolean;
          sealed?: boolean;
          cloud?: boolean;
          agent?: string;
          yes?: boolean;
        },
      ) => {
        const ctx = requireRepo();
        const agents = await listAgentsAsync();
        const parent = o.parent
          ? agents.find((a) => a.sessionId === o.parent || a.id === o.parent)
          : await findMainSession(ctx.repoId, ctx.top, agents);
        if (!parent)
          fail(
            'no session to fork. Start one with `pit`, or pass --parent <id> (see `claude agents`).',
          );
        const b = await forkWithConsent(
          {
            cwd: ctx.top,
            parentSessionId: parent.sessionId,
            task: task.join(' '),
            preset: o.preset,
            name: o.name,
            mode: o.bg ? 'bg' : 'pane',
            method: o.native ? 'native' : o.sealed ? 'sealed' : 'auto',
            cloud: o.cloud,
            agent: o.agent,
          },
          !!o.yes,
        );
        if (b.kind === 'cloud' || b.kind === 'agent') {
          const who = b.kind === 'cloud' ? 'a cloud session' : b.agent;
          process.stdout.write(
            `forked ${b.name} from ${parent.name ?? parent.sessionId.slice(0, 8)} into ${who}, starting from a summary of the conversation\n` +
              `  branch ${b.gitBranch}   worktree ${b.worktree}\n`,
          );
          if (tuiRunning(ctx.repoId)) {
            process.stdout.write('  your running `pit` opens it in a pane\n');
          } else {
            process.stdout.write(`  starting it here (no \`pit\` is open)…\n`);
            runLaunchHere(b);
            process.stdout.write(
              b.kind === 'cloud'
                ? `the cloud session keeps working; \`pit merge ${b.name}\` once it has pushed ${b.gitBranch}\n`
                : `\`pit merge ${b.name}\` to bring its work back\n`,
            );
          }
          return;
        }
        process.stdout.write(
          `forked ${b.name} from ${parent.name ?? parent.sessionId.slice(0, 8)} (${b.forkMethod}${b.forkMethod === 'sealed' ? ': parent was mid-turn' : ''})\n` +
            `  session  ${b.shortId}   branch ${b.gitBranch}   port offset ${b.portOffset}\n` +
            (o.bg
              ? `  runs in the background; \`pit merge ${b.name}\` when it is done\n`
              : `  a running \`pit\` opens it in a pane; or \`claude attach ${b.shortId}\`\n`),
        );
      },
    );

  program
    .command('merge')
    .description('bring a fork back: merge commit, unstaged changes, or leave it ready')
    .argument('<name>')
    .option('--strategy <s>', 'commit | apply | defer | pr (default: pick the safe one)')
    .option('--keep', 'keep the worktree and session after merging')
    .option('--skip-tests', 'skip the test gate')
    .option('--force', 'merge even if the fork is still working')
    .option('--from <branch>', 'cloud forks: merge this branch from origin instead of pit/<name>')
    .action(
      async (
        name: string,
        o: {
          strategy?: MergeOptions['strategy'];
          keep?: boolean;
          skipTests?: boolean;
          force?: boolean;
          from?: string;
        },
      ) => {
        const ctx = requireRepo();
        const res = await mergeBranch(ctx.top, name, { ...o, fromBranch: o.from });
        process.stdout.write(`${name}: ${res.strategy}: ${res.reason}\n`);
        if (res.files.length) process.stdout.write(`  files: ${res.files.join(', ')}\n`);
        if (res.gate && !res.gate.ok) process.stdout.write(`\n${res.gate.tail}\n`);
        if (res.strategy === 'blocked') process.exitCode = 2;
      },
    );

  program
    .command('diff')
    .description("show a fork's changes since it was forked")
    .argument('<name>')
    .action((name: string) => {
      const ctx = requireRepo();
      const b = loadBranch(ctx.repoId, name) ?? fail(`no fork named "${name}"`);
      const cwd = b.worktree ?? ctx.top;
      const target = b.worktree ? [] : [b.gitBranch];
      spawnSync('git', ['-C', cwd, 'diff', '--stat', b.snapshotCommit, ...target], {
        stdio: 'inherit',
      });
      spawnSync('git', ['-C', cwd, 'diff', b.snapshotCommit, ...target], { stdio: 'inherit' });
    });

  program
    .command('pull')
    .description("rebase a fork onto its parent's latest commits")
    .argument('<name>')
    .action((name: string) => {
      const ctx = requireRepo();
      const { outcome } = pullFromParent(ctx.top, name);
      process.stdout.write(`${name}: ${outcome}\n`);
      if (outcome === 'conflict') process.exitCode = 1;
    });

  const tree = async (o: { all?: boolean }) => {
    const ctx = requireRepo();
    const agents = await listAgentsAsync();
    const branches = listBranches(ctx.repoId);
    const main = await findMainSession(ctx.repoId, ctx.top, agents);
    const touched = await collectTouched(ctx.top, branches);
    process.stdout.write(
      treeLines({
        mainLabel: `${main?.name ?? ctx.name} (main)`,
        mainSessionId: main?.sessionId,
        branches,
        agents,
        costs: await costsFor([main?.sessionId, ...branches.map((b) => b.sessionId)]),
        touched,
        overlaps: findOverlaps(touched),
        all: o.all,
      }).join('\n') + '\n',
    );
  };
  program
    .command('tree')
    .description('branch tree of every fork in this repo')
    .option('--all', 'include merged and discarded forks')
    .action(tree);
  program
    .command('status')
    .description('same as tree')
    .option('--all', 'include merged and discarded forks')
    .action(tree);

  program
    .command('log')
    .description("a fork's commits, state and last message")
    .argument('<name>')
    .action(async (name: string) => {
      const ctx = requireRepo();
      const b = loadBranch(ctx.repoId, name) ?? fail(`no fork named "${name}"`);
      const agent = (await listAgentsAsync()).find((a) => a.sessionId === b.sessionId);
      const cost = b.sessionId ? sessionCost(b.sessionId) : undefined;
      const lines = [
        `${b.name}  ${sessionState(agent, b)}  (${b.mode}, ${b.forkMethod} fork of ${b.parentBranch ?? b.parentSessionName ?? 'main'})`,
        `task     ${b.task}`,
        `branch   ${b.gitBranch}   worktree ${b.worktree ?? '(not created yet)'}`,
        `session  ${b.shortId ?? '-'}   port offset ${b.portOffset}${cost ? `   ~$${cost.usd.toFixed(2)}` : ''}`,
      ];
      if (b.note) lines.push(`note     ${b.note}`);
      if (b.pendingAtFork?.length) lines.push(`parent was running: ${b.pendingAtFork.join('; ')}`);
      const log = git(
        ['log', '--oneline', '--no-decorate', `${b.snapshotCommit}..${b.gitBranch}`],
        ctx.top,
      );
      lines.push('', 'commits:', log.stdout.trim() ? log.stdout.trimEnd() : '  (none yet)');
      if (cost?.last) lines.push('', 'last message:', cost.last.slice(0, 1200));
      process.stdout.write(lines.join('\n') + '\n');
    });

  program
    .command('report')
    .description(
      'a shareable summary of every fork: task, result, commits, changes, test gate, cost',
    )
    .option('--live', 'only forks that are still live')
    .option('--html', 'a self-contained HTML page instead of Markdown')
    .option(
      '--out <file>',
      'where to write it; "-" prints it (e.g. into gh pr create --body-file -)',
    )
    .action(async (o: { live?: boolean; html?: boolean; out?: string }) => {
      const ctx = requireRepo();
      const agents = await listAgentsAsync();
      const main = await findMainSession(ctx.repoId, ctx.top, agents);
      const report = await buildReport(ctx.top, {
        all: !o.live,
        mainLabel: main?.name ?? ctx.name,
        mainSessionId: main?.sessionId,
      });
      if (o.out === '-') {
        process.stdout.write(o.html ? renderReportHtml(report) : renderReportMarkdown(report));
        return;
      }
      process.stdout.write(`${writeReport(report, { html: o.html, out: o.out })}\n`);
    });

  program
    .command('delete')
    .aliases(['rm', 'discard'])
    .description(
      'delete a fork: stop it and remove its worktree and branch; --finished clears history',
    )
    .argument('[name]')
    .option('--keep-branch', 'keep the git branch')
    .option('--forget', 'also remove it from `pit tree --all` and the report')
    .option('--conversation', "also delete the fork's Claude conversation (cannot be undone)")
    .option('--finished', 'remove every merged and deleted fork from the history')
    .option('--yes', "don't ask")
    .action(
      async (
        name: string | undefined,
        o: {
          keepBranch?: boolean;
          forget?: boolean;
          conversation?: boolean;
          finished?: boolean;
          yes?: boolean;
        },
      ) => {
        const ctx = requireRepo();
        const report = (r: DeleteResult) => {
          process.stdout.write(
            `deleted ${r.branch.name}${r.forgotten ? ' (and its record)' : ''}\n`,
          );
          for (const f of r.removedFiles) process.stdout.write(`  removed ${f}\n`);
          for (const n of r.notes) process.stdout.write(`  note: ${n}\n`);
        };
        if (o.finished) {
          if (name) fail('give a fork name or --finished, not both');
          const forks = finishedForks(ctx.top);
          if (!forks.length) return void process.stdout.write('no merged or deleted forks\n');
          const what = o.conversation ? ' and their conversations' : '';
          if (!o.yes) {
            process.stdout.write(
              `${forks.map((b) => `  ${b.name} (${b.state === 'merged' ? 'merged' : 'deleted'})`).join('\n')}\n`,
            );
            if (!(await askYesNo(`Remove these ${forks.length} forks from the history${what}?`)))
              fail('nothing removed (pass --yes to skip this question)');
          }
          for (const r of await clearHistory(ctx.top, { conversation: o.conversation })) report(r);
          return;
        }
        if (!name) fail('which fork? `pit delete <name>`, or `pit delete --finished`');
        if (o.conversation && !o.yes) {
          if (
            !(await askYesNo(`Delete ${name} and its Claude conversation? This can't be undone.`))
          )
            fail('nothing deleted (pass --yes to skip this question)');
        }
        report(
          await deleteFork(ctx.top, name, {
            keepBranch: o.keepBranch,
            forget: o.forget,
            conversation: o.conversation,
          }),
        );
      },
    );

  program
    .command('trust')
    .description("approve the commands in this repo's .pitstop.json (test, setup.run)")
    .option('--yes', "don't ask")
    .action(async (o: { yes?: boolean }) => {
      const ctx = requireRepo();
      const cmds = repoCommands(readRepoConfig(ctx.top));
      if (!cmds.test && !cmds.setupRun && !cmds.agents)
        return void process.stdout.write('.pitstop.json has no commands to approve.\n');
      if (repoCommandsTrusted(ctx.top, cmds))
        return void process.stdout.write('These commands are already approved.\n');
      process.stdout.write(`.pitstop.json in ${ctx.top} wants pitstop to run:\n`);
      if (cmds.test) process.stdout.write(`  test gate:  ${cmds.test}\n`);
      if (cmds.setupRun) process.stdout.write(`  fork setup: ${cmds.setupRun}\n`);
      for (const [name, a] of Object.entries(cmds.agents ?? {})) {
        process.stdout.write(`  agent ${name}: ${[a.cmd, ...(a.args ?? [])].join(' ')} <prompt>\n`);
      }
      if (!o.yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question('Allow these commands? [y/N] ');
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) return void process.stdout.write('Not approved.\n');
      }
      trustRepoCommands(ctx.top, cmds);
      process.stdout.write(
        'Approved. If .pitstop.json changes these commands, pitstop asks again.\n',
      );
    });

  program
    .command('upgrade')
    .description('install the newest pitstop now (pit also does this by itself once a day)')
    .option('--check', 'only say whether a newer version exists')
    .addOption(new Option('--auto').hideHelp())
    .action((o: { check?: boolean; auto?: boolean }) => {
      if (o.auto && !loadConfig(process.cwd()).autoUpgrade) return;
      const r = upgrade({ checkOnly: o.check });
      const say = (s: string): void => {
        process.stdout.write(`${o.auto ? `${new Date().toISOString()} ` : ''}${s}\n`);
      };
      switch (r.status) {
        case 'up-to-date':
          return say(`pitstop is up to date (${r.current})`);
        case 'available':
          return say(
            `pitstop ${r.latest} is available (you have ${r.current}); run \`pit upgrade\``,
          );
        case 'upgraded':
          return say(`pitstop updated: ${r.from} → ${r.to}`);
        case 'blocked':
          say(`not updating: ${r.reason}`);
          return void (process.exitCode = o.auto ? 0 : 1);
        case 'skipped':
          return say(`not updating: ${r.reason}`);
        case 'failed':
          say(`update failed: ${r.reason}`);
          return void (process.exitCode = 1);
      }
    });

  program
    .command('doctor')
    .description('check that Claude Code, background sessions and the terminal layer work')
    .action(async () => {
      const checks: [string, boolean, string][] = [];
      const version = runSync(claudeBin(), ['--version'], { timeoutMs: 15_000 });
      checks.push([
        'claude CLI',
        version.code === 0,
        version.stdout.trim() || version.stderr.trim(),
      ]);
      const agents = runSync(claudeBin(), ['agents', '--json'], { timeoutMs: 20_000 });
      checks.push([
        'background sessions (claude agents --json)',
        agents.code === 0,
        agents.code === 0 ? 'ok' : agents.stderr.trim(),
      ]);
      let ptyOk = true;
      let ptyNote = 'ok';
      try {
        loadPty();
      } catch (err) {
        ptyOk = false;
        ptyNote = `${String(err).split('\n')[0]}. On Linux, install build tools (python3, make, g++) and reinstall.`;
      }
      checks.push(['node-pty', ptyOk, ptyNote]);
      checks.push(['git repository', isGitRepo(process.cwd()), process.cwd()]);
      for (const [name, ok, note] of checks)
        process.stdout.write(`${ok ? '✓' : '✗'} ${name}  ${note}\n`);
      // Optional pieces: reported, never a failure.
      const optional: [string, boolean, string][] = [];
      const top = isGitRepo(process.cwd()) ? repoContext(process.cwd()).top : undefined;
      if (top) {
        const origin = originUrl(top);
        optional.push([
          'cloud forks (origin remote)',
          !!origin,
          origin ?? 'no "origin" remote; cloud forks need one on GitHub',
        ]);
      }
      for (const [name, a] of Object.entries(loadConfig(top).agents)) {
        const found = runSync('sh', ['-c', `command -v ${JSON.stringify(a.cmd)}`]).code === 0;
        optional.push([`${name} agent`, found, found ? a.cmd : `${a.cmd} not on PATH (optional)`]);
      }
      const root = packageRoot();
      const auto = loadConfig(top).autoUpgrade;
      const last = loadState();
      optional.push([
        'automatic updates',
        auto,
        `${auto ? 'on' : 'off'} · ${installKind(root)} install at ${root}${last.checkedAt ? ` · last check ${last.checkedAt.slice(0, 16).replace('T', ' ')}` : ''}${last.error ? ` · last error: ${last.error}` : ''}`,
      ]);
      for (const [name, ok, note] of optional)
        process.stdout.write(`${ok ? '✓' : '·'} ${name}  ${note}\n`);
      if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
    });

  return program;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const first = argv[0];
  if (first && (SUBCOMMANDS.has(first) || ['-h', '--help', '-V', '--version'].includes(first))) {
    await buildProgram().parseAsync(argv, { from: 'user' });
    return;
  }
  await runTui(argv);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
