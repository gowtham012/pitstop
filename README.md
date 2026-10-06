# pitstop

**Branch a running Claude Code session the way you branch code, in the same terminal.**

Your main Claude session is halfway through a 20-minute test run when something urgent comes up. Press `ctrl+\` `f`, type the task, and the terminal splits. A fork with the **full conversation** opens next to the main session, in **its own git worktree**, and both keep running. When the fork is done, `ctrl+\` `m` merges its code back safely and **tells the main session what changed**.

```
┌───────────────────────── one terminal: pit ─────────────────────────┐
│ 1 ● main · working                │ 2 ● fix-login · fork of main     │
│ ● Bash(pytest -q)                 │ > fix the login 500 error        │
│   ⎿ tests/test_memory.py … [58%]  │ ● Update(app/auth.py) +3 −1      │
│ ✻ Running… 14m                    │ ● Bash(pytest tests/test_auth) ✓ │
│                                   ├──────────────────────────────────┤
│                                   │ 3 ● bump-deps · fork of main     │
│                                   │ ● Fixing 2 type errors…          │
├───────────────────────────────────┴──────────────────────────────────┤
│  1 main ●  2 fix-login ●  3 bump-deps ●          $1.84 est · ctrl+\ ? │
└──────────────────────────────────────────────────────────────────────┘
```

## Why

Claude Code already has the pieces: `/fork`, background sessions, `claude attach`, worktrees and cross-session messages. What's missing is what you need when you're in a hurry:

- **Side by side.** Claude Code shows one session at a time. pitstop shows main and up to three forks live, with more as tabs.
- **Forking a busy session safely.** A native fork of a session that's mid-tool-call re-runs that call (see [docs/spike.md](docs/spike.md)). pitstop forks it as a _sealed copy_: the pending call is marked as the parent's job, so the fork goes straight to your task.
- **Your uncommitted work comes along.** Each fork's worktree starts from a snapshot of the parent's working tree, untracked files included. The snapshot uses a throwaway git index, so the parent's files and staging are never touched.
- **Merging into a branch that's still being worked on.** pitstop picks the safe option, and the main session is told what happened either way.
- **Fork to the cloud or to another agent.** Send a heavy task to a Claude cloud session, or hand one to Codex or Gemini CLI, and merge it back the same way.
- **A branch tree, a conflict radar, a test gate, budgets, presets and a shareable report.**

## Install

```bash
npm install -g pitstop-cli    # provides the `pit` command
pit doctor                    # checks claude, background sessions and the terminal layer
```

Requirements:

- Node 20+, git, and Claude Code with background sessions (`claude agents`). Tested with Claude Code 2.1.291.
- On Linux, `node-pty` compiles during install, so you need `python3`, `make` and `g++`.

## Quick start

```bash
cd your-repo
pit                      # starts (or reopens) the main session; extra flags go to claude
```

Inside `pit`, press `ctrl+\`, then one key:

| Key               | What it does                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `f`               | Fork the focused session into a new pane. Type the task. Tab cycles presets, or type `hotfix: <task>`. |
| `b`               | Fork into the background (no pane). The status bar shows when it's done.                               |
| `←` `→` / `1`–`9` | Move focus, or jump to a session. Clicking a pane focuses it too.                                      |
| `z`               | Zoom the focused pane to full screen and back.                                                         |
| `m`               | Merge a fork back (see below).                                                                         |
| `d`               | Open the fork's diff in a pane (`delta` if installed, otherwise `less`).                               |
| `p`               | Pull the main session's latest commits into the fork.                                                  |
| `t`               | Branch tree with state, files touched, cost and overlaps.                                              |
| `x`               | Discard a fork (stops it, removes its worktree and branch, keeps the conversation).                    |
| `e`               | Write a shareable report of every fork (see [Report](#report)).                                        |
| `s`               | Send a message to a cloud fork.                                                                        |
| `r`               | Re-attach a pane, e.g. after pressing `←` inside it opened Claude's agent view.                        |
| `q`               | Quit pit. **Every session keeps running.** Run `pit` again to get the same panes back.                 |

Pressing `ctrl+\` twice sends `ctrl+\` itself to the pane. Claude Code doesn't bind `ctrl+\`, so nothing is lost. You can change the prefix with `prefixKey`.

Everything also works from scripts or a second terminal:

```bash
pit fork "fix the login 500"          # forks this repo's main session (a running pit opens a pane for it)
pit fork --bg --preset hotfix "bump next to 15"
pit tree                              # or: pit status
pit log fix-the-login-500
pit diff fix-the-login-500
pit merge fix-the-login-500           # --strategy commit|apply|defer|pr, --keep, --skip-tests
pit pull fix-the-login-500
pit discard fix-the-login-500
pit fork --cloud "run the slow migration"      # a Claude cloud session (asks before pushing)
pit fork --agent codex "add a health check"     # Codex, Gemini CLI or any agent in config
pit report --out - | gh pr create --body-file - # everything the forks did, as a PR description
```

## Cloud forks and other agents

Presets `cloud`, `codex` and `gemini` are built in. Pick one with Tab in the fork prompt, or type `cloud: <task>`.

**What these forks know.** Claude Code can't send a local conversation into a cloud session, and Codex or Gemini CLI can't load a Claude transcript. So these forks start from a **summary of the conversation**: what you asked, what Claude said, and one line per command it ran. Tool output is left out, and the oldest turns are trimmed first. Only Claude forks on your machine get the full conversation.

**Cloud forks** (`claude --cloud`):

- Need an `origin` remote on GitHub that your Claude GitHub connection can push to.
- pitstop asks first, then pushes the fork's starting point, **including your uncommitted changes**, to `pit/<name>` on origin, and starts a cloud session on that branch.
- The cloud session is told to push its work back to `pit/<name>`. pitstop checks origin every 30 seconds and shows the fork as ready when it does.
- `ctrl+\` `s` sends the cloud session a follow-up message. The session link is shown in the pane and in `pit log`.
- Merging fetches the branch and then works like any other merge. If the session had to push somewhere else, use `pit merge <name> --from <branch>`. Afterwards the remote branch is deleted. The cloud session itself is left for you to archive.

**Agent forks** (Codex, Gemini CLI, or anything you configure):

- The first time a repo sends a summary to an agent, pitstop asks, because the summary goes to that provider (OpenAI, Google). It remembers your answer per repo and agent.
- The agent runs in a pane inside the fork's own worktree, with `PITSTOP_BRANCH` and `PITSTOP_PORT_OFFSET` set, and is told to commit there.
- Merge, test gate, radar and the report work the same. **There's no write guard**, because other agents don't run pitstop's hooks.
- Agent panes are child processes of `pit`, so quitting `pit` stops them. Their worktree and branch are kept, and next time `pit` reopens them with the agent's resume command.
- Configure agents in `~/.pitstop/config.json`. The prompt is passed as the last argument:

```json
{
  "agents": {
    "codex": {
      "cmd": "codex",
      "args": [],
      "resumeArgs": ["resume", "--last"],
      "provider": "OpenAI"
    },
    "gemini": {
      "cmd": "gemini",
      "args": ["-i"],
      "resumeArgs": ["--resume", "latest"],
      "provider": "Google"
    }
  }
}
```

To try it with the real CLIs: install and sign in to `codex` or `gemini`, run `pit doctor` to check they're on your PATH, then in `pit` press `ctrl+\` `f` and type `codex: <task>`.

## Report

`pit report` (or `ctrl+\` `e`) writes a summary of every fork in the repo. For each one it shows:

- the task and where it ran;
- the result and why (for example, "merged: commit, the parent's working tree is clean");
- the test gate result;
- commits, changes and estimated cost;
- the fork's last message.

It also includes the branch tree and any files two sessions are both changing.

- By default it's Markdown in `~/.pitstop/reports/`.
- `--out -` prints it, for example into `gh pr create --body-file -`.
- `--html` writes a self-contained page.
- `--live` only includes forks that are still running.

Merged and discarded forks are included too. pitstop saves their commits and changes before deleting their branches.

## How it works

```
 main session:  m1 ── m2 ── m3 ── m4 ── m5 (pytest still running…)
                                   │
 fork (sealed):                    └── m1…m5 + "that call is the parent's job" ── your task ── handoff ─┐
                                                                                                         │
 code:  main HEAD + uncommitted work ──snapshot S──▶ pit/fix-login (worktree) ── c1 ── c2 ── merge ──────┤
                                                                                                         ▼
                                                    main session gets <pitstop-update> after its next tool call
```

1. **Sessions.** Main and every fork are native Claude Code background sessions. They belong to Claude Code's background service, not to `pit`, so quitting `pit` or losing the terminal doesn't stop them. Each pane runs `claude attach <id>` inside a pseudo-terminal, and pitstop composes the panes on screen.
2. **Forking.**
   - If the parent is idle, pitstop uses Claude Code's own fork (`--resume <id> --fork-session --bg`).
   - If the parent is mid-turn, pitstop reads its transcript read-only up to a fixed length, closes each pending tool call with "this was still running in the parent, don't retry it", ends on a finished turn, and resumes that copy.
   - Either way, the fork's first message carries a marker, the task and the rules: work only in your worktree, commit, hand off.
3. **Hooks without installing anything.** Hooks are passed per session through `--settings`, so pitstop never edits your Claude settings.
   - **WorktreeCreate** builds the fork's worktree at `.claude/worktrees/pit-<name>` from snapshot S.
   - **PreToolUse** is a guard that stops a fork from editing or running git outside its worktree. It resolves symlinks and checks `cd`, `git -C`, wrappers and nested shells.
   - **PostToolUse** and **UserPromptSubmit** deliver pitstop's notes to a session. Each note is claimed once, with an atomic rename.
4. **Merging**, one merge at a time per repo:
   1. Commit what's left in the fork.
   2. Rebase the fork's own commits (`S..pit/<name>`, so never the parent's unfinished edits) onto the parent's current HEAD.
   3. Run the test gate, if one is set.
   4. Then pick one:
      - **commit:** the parent's tree is clean → `git merge --no-ff`.
      - **apply:** the parent is mid-edit in _other_ files and the patch applies cleanly → unstaged changes, nothing staged.
      - **defer:** anything else (same files, conflicts) → nothing is touched. The branch is left ready and the parent is told how to merge it at a safe point.
      - **pr:** with `merge.mode: "pr"`, push and open a draft PR.
5. **Telling the parent.** The fork sends its own handoff with Claude Code's cross-session messages. The merge result arrives as a `<pitstop-update>` note after the parent's next tool call, so it sees the change while it's still running.
6. **Conflict radar.** Every few seconds pitstop compares the files each session has changed. When two sessions touch the same file, both are told once and the status bar shows `!! file: main + fork`.

## Configuration

`~/.pitstop/config.json` holds your settings. `<repo>/.pitstop.json` holds the repo's. The repo's file merges on top of yours:

```json
{
  "test": "npm test",
  "testGate": true,
  "setup": { "copy": [".env"], "symlink": ["node_modules"], "run": "npm ci --prefer-offline" },
  "presets": {
    "hotfix": {
      "model": "sonnet",
      "effort": "medium",
      "permissionMode": "acceptEdits",
      "budgetUsd": 2,
      "testGate": true
    },
    "explore": { "permissionMode": "plan" }
  },
  "maxSessions": 6,
  "visibleForks": 3,
  "merge": { "mode": "local" },
  "prefixKey": "ctrl+\\"
}
```

- **Ports.** Each fork gets `PITSTOP_PORT_OFFSET` (100, 200, …) and `PITSTOP_BRANCH`. Use them in your dev server or test config so forks don't collide with main or with each other.
- **Budgets.** Claude Code can't cap a background session's spend, so pitstop stops a fork whose estimated cost passes its preset's `budgetUsd`. Costs are estimates from token usage.
- **Session cap.** `maxSessions` (default 6) counts main plus forks. All of them use your account's rate limits.

### Repository config is sandboxed

A `.pitstop.json` comes with whatever repo you cloned, so pitstop limits what it can do on its own:

- `test`, `setup.run` and `agents` commands are **ignored until you approve them** with `pit trust`. If they change later, pitstop asks again.
- Presets in a repo's config may only use the `plan`, `manual` or `acceptEdits` permission modes. Anything stronger must come from your own config.
- `setup.copy` and `setup.symlink` entries must stay inside the repo. Absolute paths, `..`, and symlinks that lead outside are skipped.

## Limitations

- The write guard is a guardrail against mistakes, not a sandbox. It covers file tools and the usual shell and git escapes, but a determined command can get around pattern checks. Use Claude Code's sandbox if you need hard isolation.
- `apply` leaves the fork's changes unstaged in a working tree that the parent agent is still editing. The parent is told, but its next edit to an unrelated part of the same file can still conflict. When in doubt, pitstop defers.
- Sealed forks depend on Claude Code's transcript format. pitstop reads it loosely and falls back to native forking when it can't find a transcript.
- Cost figures are estimates, and aren't tracked for cloud and agent forks.
- Cloud and agent forks start from a summary, not the full conversation.
- Agent forks aren't covered by the write guard, and stop when `pit` quits.
- Cloud forks are tested here against a stand-in (a local bare remote and a fake `claude --cloud`). The real check against a GitHub repo is recorded in docs/spike.md once it has run.

## Development

```bash
npm install
npm test            # builds, then runs unit, git and pty integration tests (uses a fake claude)
npm run lint && npm run typecheck
node scripts/e2e-real.mjs <trusted-repo>   # optional: drives the real claude CLI (costs a few cents)
```

[docs/spike.md](docs/spike.md) records what was checked against Claude Code before and during the build, including the busy-fork behavior, the hook contracts, and a passing end-to-end run.

## License

MIT
