# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Easy exit:** F10 twice, or the **Quit** button then Enter.
- **Short keys and buttons:** every action takes at most two keys: F1-F9 (F2 fork, F3 merge, F4 diff, F5 tree, F8 delete, F1 help) or, on a Mac, Option+letter (⌥F fork, ⌥M merge, …). The bottom bar has clickable buttons labelled with their keys. `ctrl+\` still works, and `"shortKeys": false` turns the new keys off.
- **Automatic updates:** once a day pitstop installs the newest version in the background (a source install fast-forwards its clone and builds beside `dist/`, then swaps it in; an npm install runs `npm install -g`). It never touches a clone with local changes or commits. `pit upgrade` updates now, `pit upgrade --check` only checks, and `"autoUpgrade": false` turns it off.
- **Framed panes:** each pane has a rounded frame with its name and state on top and its cost at the bottom; the focused pane is highlighted, and the bottom bar shows sessions as tabs.
- **Delete:** `pit delete <name>` (also `pit rm`; `pit discard` still works) and `ctrl+\` `x`. `--conversation`, or `c` in the popup, also deletes the fork's Claude conversation. `pit delete --finished`, or `c` in the branch tree, clears merged and deleted forks from the history. Forks that were discarded are now shown as "deleted".
- A [getting started guide](docs/guide.md): install, first fork and merge, presets, repo setup, troubleshooting, update and uninstall.

### Fixed

- Keys typed right after closing an overlay, in the same burst of input, are no longer dropped.
- Panes failed to start on macOS (`posix_spawnp failed`) because node-pty's `spawn-helper` was installed without the execute bit. pitstop now restores it.
- The README's install command (`npm install -g github:…`) fails because npm skips the build for global git installs. The README and guide now install from source.

## [0.1.0] - 2026-10-06

First release.

### Added

- **Split-pane UI:** `pit` hosts the main Claude Code session and its forks side by side in one terminal, with tabs past three forks, zoom, click to focus, and the layout restored after a restart.
- **Forking:** a native fork when the parent is idle, and a sealed copy when it is mid-turn, so the fork never re-runs the parent's in-flight tool call.
- **Isolation:** each fork works in its own worktree, built from a snapshot of the parent's uncommitted work. A write guard keeps forks out of the main checkout, and each fork gets a port slot.
- **Merging back:** one merge at a time, with a commit, apply or defer strategy and an optional test gate. The parent is notified after its next tool call.
- **Conflict radar,** branch tree, `pit log`, diff pane, pull from main, discard.
- **Presets** with budgets. Tab cycles them in the fork prompt.
- **Cloud forks** (`claude --cloud`) and **agent forks** (Codex, Gemini CLI, or any configured CLI), both starting from a conversation summary.
- **`pit report`:** a shareable Markdown or HTML summary of every fork.
- **Repository config is sandboxed:** its commands need `pit trust`, and it can only use safe permission modes.

[Unreleased]: https://github.com/gowtham012/pitstop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gowtham012/pitstop/releases/tag/v0.1.0
