# Getting started with pitstop

This guide takes you from nothing installed to forking, merging and reporting.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Install](#2-install)
- [3. Check your setup](#3-check-your-setup)
- [4. Start pitstop in your repo](#4-start-pitstop-in-your-repo)
- [5. Fork your first task](#5-fork-your-first-task)
- [6. Watch, review and steer the fork](#6-watch-review-and-steer-the-fork)
- [7. Merge it back](#7-merge-it-back)
- [8. Quit and come back later](#8-quit-and-come-back-later)
- [Everyday recipes](#everyday-recipes)
- [Set up your repo](#set-up-your-repo)
- [Troubleshooting](#troubleshooting)
- [Update and uninstall](#update-and-uninstall)

## 1. Check the requirements

| You need                                    | Check with             |
| ------------------------------------------- | ---------------------- |
| macOS or Linux                              |                        |
| Node.js 20 or newer                         | `node --version`       |
| git                                         | `git --version`        |
| Claude Code, signed in                      | `claude --version`     |
| Background sessions in your Claude Code     | `claude agents --json` |
| Linux only: `python3`, `make`, `g++` (once) | `g++ --version`        |

The Linux build tools are needed because `node-pty`, the library pitstop uses to host terminals, is compiled during install. On Debian or Ubuntu: `sudo apt install python3 make g++`.

## 2. Install

pitstop isn't on npm yet, so install it from source:

```bash
git clone https://github.com/gowtham012/pitstop.git
cd pitstop
npm install          # installs dependencies and builds dist/
npm install -g .     # puts `pit` on your PATH
```

`npm install -g .` links the global `pit` command to this folder, so keep the folder.

> [!NOTE]
> `npm install -g github:gowtham012/pitstop` does **not** work: npm skips the build step for global installs straight from git. Use the steps above until the first npm release, which will be `npm install -g pitstop-cli`.

## 3. Check your setup

Run this inside any git repo:

```bash
pit doctor
```

You should see:

```text
✓ claude CLI  2.1.292 (Claude Code)
✓ background sessions (claude agents --json)  ok
✓ node-pty  ok
✓ git repository  /path/to/your-repo
✓ cloud forks (origin remote)  https://github.com/you/your-repo
· codex agent  codex not on PATH (optional)
· gemini agent  gemini not on PATH (optional)
```

Lines with `✓` are required. Lines with `·` are optional extras. If something has an `✗`, see [Troubleshooting](#troubleshooting).

## 4. Start pitstop in your repo

```bash
cd your-repo
pit
```

What happens:

1. pitstop starts a **main session**. This is a normal Claude Code background session that works in your checkout, like `claude` would.
2. The terminal switches to pitstop's screen, with the main session filling the window and a status bar at the bottom.
3. You use the main session exactly as you use Claude Code: type, approve tools, use slash commands.

Any flags after `pit` are passed to `claude`, for example `pit --model sonnet`. If you already have a background session you want to use as main, run `pit --main <session id>`; `claude agents` lists the ids.

> [!TIP]
> The first time you use Claude Code in a folder, it asks whether you trust it. Background sessions can't ask, so if pitstop says "Workspace not trusted", run `claude` once in that folder, accept, quit, and run `pit` again.

## 5. Fork your first task

Say the main session is busy running a long test suite, and you need a bug fixed right now.

1. Press `ctrl+\`, release, then press `f`. A prompt appears at the bottom:

   ```text
   fork of main · no preset (Tab) · task: _
   ```

2. Type the task and press Enter:

   ```text
   fork of main · no preset (Tab) · task: fix the 500 on /login
   ```

3. The screen splits. The main session keeps running on the left, and the fork opens on the right:
   - it already knows everything the main session knew;
   - it works in its own git worktree, `.claude/worktrees/pit-fix-the-500-on-login`, which starts from your current files, including uncommitted changes;
   - it commits its work on the branch `pit/fix-the-500-on-login`.

Keys you type now go to the fork, because it has focus. Press `ctrl+\` `←` to go back to main, or click a pane.

**Presets.** Press Tab in the fork prompt to cycle through presets, or type `name: task`:

| Preset    | What it does                                                    |
| --------- | --------------------------------------------------------------- |
| `hotfix`  | accepts edits without asking, medium effort, runs the test gate |
| `explore` | plan mode: reads and proposes, doesn't edit                     |
| `cloud`   | runs as a Claude cloud session (see the README)                 |
| `codex`   | runs Codex CLI in the fork's worktree, if installed             |
| `gemini`  | runs Gemini CLI in the fork's worktree, if installed            |

**Background forks.** `ctrl+\` `b` forks without opening a pane. The status bar shows when it's done.

## 6. Watch, review and steer the fork

| Do this                                 | Press                         |
| --------------------------------------- | ----------------------------- |
| Switch between panes                    | `ctrl+\` `←` `→`, or `1`–`9`  |
| Make one pane full screen and back      | `ctrl+\` `z`                  |
| See what the fork changed               | `ctrl+\` `d` (q closes it)    |
| Give the fork main's newest commits     | `ctrl+\` `p`                  |
| See every branch, its cost and overlaps | `ctrl+\` `t` (any key closes) |
| List all keys                           | `ctrl+\` `?`                  |

The status bar marks each session: `●` working, `?` waiting for your answer, `·` idle (finished its turn), `✓` ready (cloud forks) or merged. If two sessions edit the same file, the **conflict radar** warns you in the status bar.

You can talk to the fork like any Claude session: switch to its pane and type.

## 7. Merge it back

When the fork is idle (`·`), press `ctrl+\` `m` (pick the fork if there are several) and confirm with `y`.

pitstop then:

1. runs your tests in the fork's worktree, if the test gate is on, and stops if they fail;
2. replays the fork's commits on top of main's latest commit;
3. brings them into your checkout the safe way:
   - **commit**: a merge commit, when main has no uncommitted changes;
   - **apply**: unstaged changes, when main is editing other files;
   - **defer**: leaves the branch ready and tells main how to merge it, when main is editing the same files;
4. tells the main session what changed. The note arrives after main's next tool call, so you don't have to type anything;
5. removes the fork's worktree, branch and session. Use `pit merge <name> --keep` to keep them.

If you don't want the fork's work, press `ctrl+\` `x` to discard it. The worktree and branch are deleted, and the conversation stays in Claude Code's history.

## 8. Quit and come back later

Press `ctrl+\` `q`, then `y`.

- Claude sessions (main and forks) **keep running** in the background.
- Run `pit` again in the same repo to get the same panes back.
- Codex and Gemini panes do stop when you quit; pitstop resumes them next time.

## Everyday recipes

All of these work from a second terminal or a script. A running `pit` picks up new forks and opens a pane for them.

```bash
pit fork "fix the login 500"                      # fork main with the full conversation
pit fork --preset hotfix "bump next to 15"        # with a preset
pit fork --bg "update the changelog"              # no pane
pit tree                                          # what's running, what's done
pit diff fix-the-login-500                        # the fork's changes
pit log fix-the-login-500                         # its commits and last message
pit merge fix-the-login-500                       # bring it home
pit merge fix-the-login-500 --strategy pr         # or push it and open a PR instead
pit discard update-the-changelog                  # throw one away
pit report                                        # Markdown summary of every fork
pit report --html --out forks.html                # as a web page
pit report --out - | gh pr create --body-file -   # straight into a PR description
```

Fork a fork with `pit fork --parent <session id> "task"`, or press `ctrl+\` `f` while the fork's pane has focus.

## Set up your repo

Add `.pitstop.json` to your repo so every fork can build and test:

```json
{
  "test": "npm test",
  "testGate": true,
  "setup": {
    "copy": [".env"],
    "symlink": ["node_modules"],
    "run": "npm ci --prefer-offline"
  }
}
```

- `setup.copy` and `setup.symlink` bring files git doesn't track into each new worktree.
- `setup.run` runs once in each new worktree.
- `test` is what the test gate runs before a merge.

Because anyone can commit this file, pitstop ignores its commands until you approve them:

```bash
pit trust      # shows the commands and asks; asks again if they change
```

Each fork also gets `PITSTOP_PORT_OFFSET` (100, 200, …) and `PITSTOP_BRANCH` in its environment. Use them in your dev server and test config so forks don't fight over ports.

Your own settings live in `~/.pitstop/config.json` and use the same format. The [README](../README.md#configuration) lists every option.

## Troubleshooting

| You see                                          | Do this                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `✗ node-pty` on Linux                            | Install `python3 make g++`, then run `npm install` again in the pitstop folder.                   |
| `posix_spawnp failed` on macOS                   | Run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper` in the pitstop folder.              |
| `✗ background sessions`                          | Update Claude Code (`claude update`); background sessions need a recent version.                  |
| "Workspace not trusted"                          | Run `claude` once in that folder and accept the trust prompt.                                     |
| A pane shows "describe a task for a new session" | You pressed `←` on an empty prompt. Press `ctrl+\` `r` to re-attach.                              |
| `ctrl+\` does nothing                            | Your terminal or tmux may catch it. Set another key, e.g. `"prefixKey": "ctrl+]"` in your config. |
| Merge says the fork is "still working"           | Wait until it's idle (`·`), or answer it if it shows `?`. `--force` merges anyway.                |
| "ignored until you run `pit trust`"              | Read the commands it lists, then run `pit trust`.                                                 |

Still stuck? Open an issue with the output of `pit doctor`: https://github.com/gowtham012/pitstop/issues

## Update and uninstall

Update:

```bash
cd pitstop
git pull
npm install
```

Uninstall:

```bash
npm uninstall -g pitstop-cli
rm -rf ~/.pitstop          # pitstop's state: branch records, notes, reports
```

Your Claude sessions and git branches are untouched. Remove leftover fork worktrees with `pit discard <name>` before uninstalling, or with `git worktree remove` afterwards.
