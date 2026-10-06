import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../core/paths.js';

export interface GuardInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Session's current directory (the parent checkout until the fork enters its worktree). */
  cwd: string;
  /** The fork's own worktree, once it exists. */
  worktree?: string;
  /** Main checkout of the repository. */
  repoTop: string;
}

export type GuardDecision = { deny: false } | { deny: true; reason: string };

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** git subcommands that only read. Anything else is treated as changing files, the index or refs. */
const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'grep',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'version',
  'help',
  'remote',
  'whatchanged',
  'count-objects',
  'check-ignore',
  'var',
]);

/** `git branch` flags that only list. Any other argument creates, moves or deletes a branch. */
const BRANCH_LIST_FLAGS =
  /^(?:-a|-r|-v|-vv|-l|--list|--all|--remotes|--verbose|--show-current|--no-column|--column(?:=.*)?|--sort=.*|--format=.*|--contains|--no-contains|--merged|--no-merged|--points-at|--color(?:=.*)?|--no-color)$/;

/** git options that come before the subcommand and take a value (also accepted as --opt=value). */
const GIT_GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--attr-source',
  '--list-cmds',
]);

/** git options that come before the subcommand and take no value. Any other option fails closed. */
const GIT_GLOBAL_NO_VALUE = new Set([
  '--no-pager',
  '-p',
  '--paginate',
  '-P',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
  '--no-lazy-fetch',
]);

/** Words that run the command after them: `sudo git …`, `xargs git …`, `if git …`. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'ionice',
  'timeout',
  'xargs',
  'stdbuf',
  'chronic',
  '!',
  '{',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  'builtin',
]);

/**
 * Split a shell command into simple commands and words, honoring quotes and
 * backslashes, so `git "branch" -D x` and `git branch --del x` are seen for
 * what they are. Not a full shell parser; enough for a guardrail.
 */
export function shellWords(cmd: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < cmd.length) {
      word += cmd[++i];
      inWord = true;
    } else if (
      ch === ';' ||
      ch === '&' ||
      ch === '|' ||
      ch === '\n' ||
      ch === '(' ||
      ch === ')' ||
      ch === '`'
    ) {
      endCommand();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const BRANCH_LIST_VALUE_FLAGS = new Set([
  '--contains',
  '--no-contains',
  '--merged',
  '--no-merged',
  '--points-at',
  '--sort',
  '--format',
]);

/** `git branch` only lists when every flag is a listing flag, and names appear only as --list patterns. */
function branchIsListing(args: string[]): boolean {
  const listing = args.includes('--list') || args.includes('-l');
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (BRANCH_LIST_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) {
      if (!BRANCH_LIST_FLAGS.test(a)) return false;
    } else if (!listing) return false;
  }
  return true;
}

const CONFIG_READ =
  /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--name-only)$/;
const CONFIG_WRITE =
  /^(--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/;

/** Classify one git invocation starting at words[start] (the `git` word). True when it changes state. */
function gitInvocationMutates(words: string[], start: number): boolean {
  let i = start + 1;
  while (i < words.length && words[i]!.startsWith('-')) {
    const opt = words[i]!;
    const name = opt.split('=')[0]!;
    if (opt === '--version' || opt === '--help' || opt === '-h') return false;
    if (GIT_GLOBAL_NO_VALUE.has(opt)) i += 1;
    else if (GIT_GLOBAL_WITH_VALUE.has(name)) i += opt.includes('=') ? 1 : 2;
    else return true; // unknown global option: fail closed
  }
  const sub = words[i];
  if (!sub) return false;
  const args = words.slice(i + 1);
  if (
    ['diff', 'log', 'show', 'whatchanged'].includes(sub) &&
    args.some((a) => a === '-o' || a.startsWith('--output'))
  ) {
    return true; // writes files
  }
  switch (sub) {
    case 'branch':
      return !branchIsListing(args);
    case 'stash':
      return !(args[0] === 'list' || args[0] === 'show');
    case 'tag':
      return !(
        args.length === 0 || args.every((a) => /^(-l|--list|-n\d*|--sort=.*|--contains)$/.test(a))
      );
    case 'worktree':
      return args[0] !== 'list';
    case 'remote':
      return args.length > 0 && !['-v', '--verbose', 'show', 'get-url'].includes(args[0]!);
    case 'config':
      if (args[0] === 'get' || args[0] === 'list') return false;
      return !(args.some((a) => CONFIG_READ.test(a)) && !args.some((a) => CONFIG_WRITE.test(a)));
    default:
      return !READ_ONLY_GIT.has(sub);
  }
}

const isGitWord = (w: string) => w === 'git' || w.endsWith('/git');

/**
 * True when any git invocation in `cmd` would change files, the index or refs.
 * Looks through wrappers (sudo, xargs, if, …) and into nested shells
 * (`sh -c "…"`, `eval "…"`), and treats anything it can't classify as a change.
 */
export function gitMutates(cmd: string, depth = 0): boolean {
  if (depth > 3) return /\bgit\b/.test(cmd);
  for (const words of shellWords(cmd)) {
    // Quoted strings with spaces may be scripts for a nested shell or eval.
    if (words.some((w) => /\s/.test(w) && /\bgit\b/.test(w) && gitMutates(w, depth + 1)))
      return true;
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++; // VAR=value prefixes
    if (i >= words.length) continue;
    if (isGitWord(words[i]!)) {
      if (gitInvocationMutates(words, i)) return true;
    } else if (WRAPPERS.has(words[i]!)) {
      const g = words.findIndex((w, k) => k > i && isGitWord(w));
      if (g !== -1 && gitInvocationMutates(words, g)) return true;
    }
  }
  return false;
}

const ALLOW: GuardDecision = { deny: false };

/**
 * Resolve symlinks on the deepest part of `p` that exists, so a link inside
 * the worktree that points at the main checkout is judged by where it leads.
 */
export function realResolve(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Inside the main checkout but not inside the fork's own worktree (other forks' worktrees count as outside). */
function forbidden(p: string, g: GuardInput, own: string | undefined): boolean {
  const real = realResolve(p);
  const top = realResolve(g.repoTop);
  if (own && isInside(real, realResolve(own))) return false;
  return isInside(real, top);
}

/**
 * Keep a fork inside its own worktree. Native forks are only told to stay
 * out of the parent's checkout; this enforces it for file tools and catches
 * the common shell escapes. It is a guardrail against mistakes, not a
 * sandbox: a determined command can still get around regex checks.
 */
export function guardDecision(g: GuardInput): GuardDecision {
  const own = g.worktree;
  if (FILE_TOOLS.has(g.toolName)) {
    const raw = (g.toolInput.file_path ?? g.toolInput.notebook_path) as string | undefined;
    if (!raw) return ALLOW;
    const file = path.resolve(own ?? g.cwd, raw);
    if (!forbidden(file, g, own)) return ALLOW;
    return {
      deny: true,
      reason: own
        ? `pitstop: ${raw} is outside this fork's worktree (${own}). Edit the copy inside your worktree instead; the main session is still working in ${g.repoTop}.`
        : `pitstop: this fork has no worktree yet. Call EnterWorktree first, then edit files inside it. The main session is still working in ${g.repoTop}.`,
    };
  }
  if (g.toolName !== 'Bash') return ALLOW;

  const cmd = String(g.toolInput.command ?? '');
  const cwdOutside = !own || !isInside(realResolve(g.cwd), realResolve(own));
  if (cwdOutside && forbidden(g.cwd, g, own) && gitMutates(cmd)) {
    return {
      deny: true,
      reason: own
        ? `pitstop: this command would run git in ${g.cwd}, outside this fork's worktree (${own}). cd into your worktree first.`
        : `pitstop: this fork is still in the main checkout (${g.repoTop}), where the main session is working. Call EnterWorktree before running git commands that change files or branches.`,
    };
  }
  const base = own && !cwdOutside ? g.cwd : (own ?? g.cwd);
  const targets = [...absolutePaths(cmd), ...dirArguments(cmd).map((d) => path.resolve(base, d))];
  for (const p of targets) {
    if (forbidden(p, g, own) && (own || gitMutates(cmd) || /\bcd\b/.test(cmd))) {
      return {
        deny: true,
        reason: own
          ? `pitstop: the command touches ${p}, which is outside this fork's worktree (${own}). Use paths inside your worktree.`
          : `pitstop: the command touches ${p} in the main checkout. Call EnterWorktree first.`,
      };
    }
  }
  return ALLOW;
}

/** Absolute paths mentioned in a shell command (good enough for a guard, not a parser). */
export function absolutePaths(cmd: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s"'=:(])(\/[^\s"';|&)<>]+)/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) if (m[1]) out.push(m[1]);
  return out;
}

/** Relative directories a command moves into or points git at: `cd X`, `git -C X`, `--git-dir=X`, `--work-tree X`. */
export function dirArguments(cmd: string): string[] {
  const out: string[] = [];
  const re =
    /(?:\bcd\s+|\bgit\s+-C\s+|--git-dir[=\s]+|--work-tree[=\s]+|\bpushd\s+)(["']?)([^\s"';|&)]+)\1/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) {
    const d = m[2];
    if (d && !d.startsWith('/') && d !== '-' && !d.startsWith('$') && !d.startsWith('~'))
      out.push(d);
  }
  return out;
}
