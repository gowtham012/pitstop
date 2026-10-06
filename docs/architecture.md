# Architecture

A map of the code for contributors. The README covers what pitstop does; this page covers where each part lives.

```
src/
  cli.ts                `pit` with no command opens the UI; subcommands: fork, merge, diff, pull, tree, log, report, discard, trust, doctor
  version.ts
  branches.ts           BranchRecord / SessionRecord: one JSON file per fork and per session under ~/.pitstop
  inbox.ts              notes to a session; claimed once by atomic rename, sanitized before delivery
  radar.ts              files changed by more than one session
  status.ts             session state, cost estimate, branch tree lines
  report.ts             `pit report`: Markdown and HTML
  core/
    paths.ts            ~/.pitstop layout, repo id, slugs, containment checks
    store.ts            atomic JSON writes, name claims, directory locks
    exec.ts             child processes
    git.ts              thin git helpers
    snapshot.ts         uncommitted work → commit S, through a throwaway index
    config.ts           defaults → ~/.pitstop/config.json → <repo>/.pitstop.json (sanitized; `pit trust`)
  claude/
    agents.ts           `claude agents --json`, `claude --bg`, stop and rm
    transcript.ts       read a live transcript safely, active chain, sealed copy, token usage
    digest.ts           conversation summary for cloud and agent forks
    locate.ts           find a session's transcript
    settings.ts         the per-session --settings value: hooks, env, permissions
  fork/
    common.ts           shared setup: cap, name, snapshot, port slot, consent
    fork.ts             entry point; Claude forks (native or sealed)
    cloud.ts            cloud forks: push, `claude --cloud`, readiness, follow-ups
    agent.ts            Codex, Gemini CLI and other agents
    prompt.ts           the fork's first message, and the marker that identifies it
    worktree.ts         worktree from S, setup copy/symlink/run
    main.ts             start or reuse the main session
  merge/
    plan.ts             pure decision table: commit / apply / defer / pr / nothing
    merge.ts            merge, discard, pull; saves what the report needs
    gate.ts             test gate
  hook/
    entry.ts            the hook Claude Code runs (bundled to dist/hook.js); must be fast and never fail a session
    guard.ts            the write guard: file tools, shell words, git classification, output targets
  tui/
    app.ts              the split-pane UI: panes, overlays, refresh loop, keys
    pane.ts             one child in a pty, mirrored into a headless xterm
    screen.ts           cell grid, diffing, styles, control-character stripping
    layout.ts           pure layout math
    input.ts            prefix-key router and the line editor
    presence.ts         lets the CLI know a UI is open
```

## How a Claude fork happens

1. `fork/common.ts` `prepareFork`:
   - checks the session cap;
   - claims a unique name;
   - snapshots the parent's working tree into commit S (`core/snapshot.ts`);
   - picks a port slot;
   - saves a `BranchRecord` in state `starting`.
2. `fork/fork.ts` chooses the method:
   - **native** when the parent is idle: `claude --resume <id> --fork-session --bg`;
   - **sealed** when it's busy: `claude/transcript.ts` `sealTranscript` makes a copy, which is resumed under its own id.
3. The fork's settings (`claude/settings.ts`) add these hooks:
   - **WorktreeCreate:** builds the worktree from S;
   - **PreToolUse:** the guard;
   - **PostToolUse** and **UserPromptSubmit:** deliver inbox notes;
   - **SessionStart:** reminds the fork what it is.
4. The UI opens a pane running `claude attach <id>`.

## How a merge happens

`merge/merge.ts` `mergeBranch` runs under a per-repo lock:

1. Commit what's left in the fork. Cloud forks fetch their pushed branch first.
2. Rebase `S..pit/<name>` onto the parent's HEAD.
3. Run the test gate.
4. Let `merge/plan.ts` decide the strategy, then apply it.
5. Send the parent an inbox note.
6. Save the report fields, and clean up the worktree, session and branch.

## Invariants

Keep these true. CONTRIBUTING.md lists them as the ground rules.

- **The parent session is only ever read.** Its transcript is read up to a fixed length; snapshots use a throwaway index; the main checkout changes only through an explicit merge.
- **The user's Claude settings are never edited.**
- **Repository config is untrusted.**
- **Text from forks is escaped** before it reaches another context or the screen.

## Tests

- `test/unit`: pure logic, plus git-backed tests in temporary repos (`repo.test.ts`, `forks.test.ts`).
- `test/integration/tui.test.ts`: drives the built `pit` in a pseudo-terminal against `test/bin/fake-claude.mjs` and `fake-agent.mjs`.
- `scripts/e2e-real.mjs`: optional, uses the real `claude` CLI.
