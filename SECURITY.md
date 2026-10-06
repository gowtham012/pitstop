# Security policy

pitstop runs coding agents on your machine. It decides what a fork may touch, and it reads configuration from repositories you clone. Security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: [Report a vulnerability](https://github.com/gowtham012/pitstop/security/advisories/new).

Include:

- what an attacker controls (a cloned repo's `.pitstop.json`, a file name, a fork's output, …);
- what they can make pitstop do;
- steps to reproduce.

You'll get a reply within a few days. Once a fix ships, the advisory is published with credit to you, unless you'd rather stay anonymous.

## What is in scope

- A repository's `.pitstop.json` running a command, raising permissions, or reading files outside the repo without `pit trust`.
- Fork-controlled text (file names, messages, test output) injecting instructions into another session's context, or escape sequences into your terminal.
- The fork write guard letting a fork change the main checkout in a way it should catch (see the limits below).
- pitstop leaking transcript content to a provider or remote without the confirmation it promises.

## Known limits

- **The write guard is a guardrail against mistakes, not a sandbox.** It covers file tools and common shell and git escapes. A determined command can still get around pattern checks. Bypasses are still worth reporting, but if you need hard isolation, use Claude Code's sandbox.
- **Agent forks (Codex, Gemini CLI) have no write guard,** because those tools don't run pitstop's hooks.
- **Cloud forks push your current work, uncommitted changes included, to your `origin` remote.** pitstop asks before every cloud fork.

## Supported versions

Security fixes go into the latest release.
