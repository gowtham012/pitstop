# M0 spike: Claude Code primitives

Run on 2026-10-06 against Claude Code **v2.1.291** on Linux. Each finding below says what we tried, what happened, and what pitstop does about it.

## 1. `claude agents --json`

Prints a JSON array of live sessions. Interactive sessions look like this:

```json
{
  "pid": 94,
  "cwd": "/home/user/GetPitlane",
  "kind": "interactive",
  "startedAt": 1791303637452,
  "sessionId": "adbc5b98-…",
  "name": "getpitlane-20",
  "status": "busy"
}
```

Background sessions also carry a short `id`, a `state`, and sometimes `waitingFor`:

```json
{
  "pid": 1788,
  "id": "651b085b",
  "cwd": "…/repo",
  "kind": "background",
  "startedAt": 1791305378763,
  "sessionId": "651b085b-6b5e-…",
  "name": "pitspike-main",
  "status": "idle",
  "state": "done"
}
```

Values seen:

- `status`: `busy`, `idle`, `waiting`
- `state`: `working`, `blocked`, `done`
- `waitingFor`: e.g. `permission prompt`

`--all` also includes finished sessions. After a session moves into a worktree, its `cwd` changes to the worktree path.

**pitstop:** `src/claude/agents.ts` parses this loosely. Every field is optional, and unknown fields are kept.

## 2. Background sessions and native forking

- `claude --bg -n <name> "<prompt>"` prints `backgrounded · <shortId> · <name>`. The first run also prints `Starting background service…`.
- `claude --resume <sessionId> --fork-session --bg -n <name> "<prompt>"` starts a **copy with the full history** and the prompt. The test fork correctly recalled a word told only to the parent.
- **Without `--fork-session`**, `--resume <id> --bg` _continues_ an idle session under its own id instead of copying it. pitstop always passes `--fork-session`.
- `--bg` **ignores `--session-id`** (it prints a warning). pitstop reads the short id from the output and looks up the full `sessionId` in `claude agents --json`.
- **Pitfall:** `--allowedTools <tools...>` takes a variable number of values, so it swallowed the prompt. The session started with no prompt and showed "idle — send a prompt to start". pitstop never passes variadic flags. Permissions, hooks and env go in one `--settings '<json>'` value, and the prompt goes last.
- Background sessions need the folder to be **trusted** first (otherwise: "Workspace not trusted. Run `claude` … once"). `pit` shows that message instead of failing silently.

## 3. Forking a busy session

- **Native fork while the parent is mid-tool-call:** the copy gets an empty `tool_result` for the pending call, and the model **re-runs the parent's in-flight command** (it repeated `sleep 90`) before reading the fork's task. A fork should never do that.
- **Sealed copy (our approach):** read the parent transcript read-only and keep the active chain. For each pending `tool_use`, add a `tool_result` with `is_error: true` saying "this was still running in the parent; it is the parent's job, do not retry it". End with a short synthetic assistant turn. Save the copy in the same project folder under a new id and run `claude --resume <newId> --bg … "<task>"`.
  - Result: the fork did **not** re-run the command and went straight to its task (`sealed-ok`). `claude attach` showed it correctly.

**pitstop:** if the parent's `status` is `busy`, use the sealed copy; if it's idle, use the native fork. The copy goes in `dirname(parent transcript_path)`, so pitstop never has to recompute Claude's project-folder naming.

## 4. `claude attach` inside our pane

- `node-pty` + `@xterm/headless` render the whole Claude Code UI correctly: banner, colors, prompt box, footer. `node-pty` 1.1.0 has no Linux prebuilt binary and was compiled during install, which needs build tools on Linux.
- Pressing `←` on an empty prompt does **not** end `attach`. It switches the pane to agent view ("describe a task for a new session").

**pitstop:** detects that screen and offers `r` to re-attach. Since `←` only does this on an empty prompt, pitstop doesn't swallow it.

## 5. Hooks passed through `--settings`

Hooks given in a session's `--settings` value **do run in background sessions**, so pitstop never needs to change your global settings to work.

- **WorktreeCreate:** the input in v2.1.291 is
  `{ session_id, transcript_path, cwd, scratchpad_dir, prompt_id, hook_event_name: "WorktreeCreate", name }`.
  - There is **no `worktree_path` or `base_branch`**, even though the docs list them. The hook has to create the worktree itself and print its path.
  - If the hook prints nothing, Claude falls back to running `git worktree add .claude/worktrees/<name>` through Bash, which needs a permission prompt.
  - Native worktrees live at `<repo>/.claude/worktrees/<name>`. pitstop uses the same folder, so forks inherit the repo's workspace trust.
  - With our hook, the session moved into the worktree we built from the snapshot commit, and `agents --json` showed the new `cwd`.
- **PreToolUse:** fired for `Write` with `tool_input.file_path` already inside the worktree. The deny format is the standard one: `hookSpecificOutput.permissionDecision: "deny"` plus a `permissionDecisionReason`.
- **SessionStart:** `source` is `startup`, `resume`, `clear`, `compact` or `fork`.
- **Main session:** pitstop starts it with `"worktree": {"bgIsolation": "none"}` so it keeps editing your checkout. Only forks get isolated.

## 6. Cross-session messages

- A background child used ListAgents + SendMessage to reach a parent named `pitspike-parent`, started with `--settings '{"crossSessionInbound":"accept"}'`.
- The parent received:

  ```
  <cross-session-message from="uds:/tmp/cc-socks/5134.sock" from-name="pitspike-child" …>
  handoff from child: hello.txt fixed
  </cross-session-message>
  ```

  It started a new turn because it was idle.

**pitstop:** the main session is started with `crossSessionInbound: accept`. Each fork's prompt tells it to SendMessage a handoff to the parent by name. Merge results also go through the hook inbox, which works even when messaging is off.

## 7. Keys

Claude Code doesn't bind `ctrl+\` in any context ([keybindings docs](https://code.claude.com/docs/en/keybindings)). That makes it a safe prefix, and pitstop takes it from the real terminal before the panes see it. `Ctrl+B` (task background, tmux), `Ctrl+X` chords, `Ctrl+S`, `Ctrl+T`, `Ctrl+G` and `Ctrl+R` are all taken by Claude Code.

## Decisions this changes

| Topic                  | Before the spike                | Now                                                                    |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| Fork path              | own transcript cut as fallback  | native fork when the parent is idle, sealed copy when it's busy        |
| Learning the fork's id | `--session-id`                  | parse `backgrounded · <id>` and look it up in `agents --json`          |
| Worktree folder        | `~/.pitstop/worktrees`          | `<repo>/.claude/worktrees/pit-<name>` (inherits trust, same as native) |
| Installing hooks       | plugin or global settings merge | per-session `--settings` (zero install); a plugin is optional          |
| Main session isolation | n/a                             | `worktree.bgIsolation: none`                                           |

## End-to-end check with the real CLI

`scripts/e2e-real.mjs` runs the built `pit` in a pseudo-terminal against the real `claude` CLI (Claude Code 2.1.291). Run on 2026-10-06, it passed every step:

1. `pit` started the main session as a background session and attached it in the left pane. Main was told the codename `BLUEBIRD-42`.
2. `ctrl+\` `f`, then `hotfix: Create a file named hello.txt whose only content is the codename I asked you to remember. Then git commit it.`
   - The fork opened in a right-hand pane while main stayed live.
   - Using the conversation it inherited, the fork wrote `BLUEBIRD-42` to `hello.txt` inside `.claude/worktrees/pit-<name>`, a worktree our WorktreeCreate hook built from the snapshot commit, and committed it.
3. The fork's own SendMessage handoff arrived in main as a native cross-session message.
4. `ctrl+\` `m`, `y`. Result: `commit`, because main's tree was clean. `hello.txt` appeared in the main checkout as a merge commit, and the fork's worktree, branch and session were cleaned up.
5. Asked whether it had received a pitstop-update, main named the merge and `hello.txt`. The inbox note had been delivered by the hook.

The first run found one gap: the fork stopped on a permission prompt for `git add`/`git commit`. Fork sessions now pre-allow `git add/commit/status/diff/log/show` (`FORK_ALLOW` in `src/claude/settings.ts`). The PreToolUse guard still keeps those commands inside the fork's worktree.

The same run also confirmed that merging a fork that is waiting for input is refused ("still working").
