# Contributing to pitstop

Thanks for helping. pitstop is small enough that one person can understand all of it in an afternoon. Please help keep it that way.

## Ways to help

- **Try it and report what breaks.** Tell us your terminal, OS, Node version and `claude --version`. Rendering bugs depend heavily on the terminal.
- **Fix a bug or add a feature.** For anything bigger than a small fix, open an issue first so we can agree on the approach.
- **Improve the docs.** If something confused you, it will confuse the next person too.
- **Try other agents.** Codex and Gemini CLI support is tested only against a stand-in. Reports from real runs are very welcome.

## Set up

```bash
git clone https://github.com/gowtham012/pitstop.git
cd pitstop
npm install        # on Linux, node-pty needs python3, make and g++
npm test           # builds, then runs everything against a fake claude
```

You don't need a Claude account to develop. The tests use `test/bin/fake-claude.mjs` and `test/bin/fake-agent.mjs`. To try your change for real, run `npm run build && node dist/cli.js` inside a git repo. The optional `node scripts/e2e-real.mjs <trusted-repo>` drives the real `claude` CLI and costs a few cents of tokens.

## Before you open a pull request

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

All four must pass; CI runs them on Linux and macOS with Node 20 and 22. Also:

- **Add a test for the change.** Pure logic goes in `test/unit`, behavior that needs git in `test/unit/repo.test.ts` or `forks.test.ts`, and anything you'd see on screen in `test/integration/tui.test.ts`.
- **Keep the change focused.** One change per PR, with no drive-by reformatting.
- **Write commit messages as conventional commits** (`feat(fork): …`, `fix(ui): …`, `docs: …`). Scopes in use: `core`, `fork`, `merge`, `ui`, `hook`, `report`, `security`, `docs`, `ci`.
- **Add a line to `CHANGELOG.md`** under "Unreleased" for anything users will notice.

## Ground rules for the code

- **Never disturb the main session.** pitstop reads transcripts read-only, snapshots with a throwaway git index, and never writes into the parent's checkout except through an explicit merge. Changes that weaken this need a very good reason.
- **Never edit the user's Claude settings.** Hooks travel per session through `--settings`.
- **Treat repository config as untrusted.** Anything in a repo's `.pitstop.json` that runs a command or raises permissions must go through `pit trust` (see `src/core/config.ts`).
- **Escape text you didn't write.** Escape fork- or repo-controlled text before it reaches another session's context (`sanitizeForContext`) or the screen (`stripControls`).
- **Check Claude Code behavior instead of guessing.** If your change relies on how Claude Code behaves, verify it and note what you found in `docs/spike.md`.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit together.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
