# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
