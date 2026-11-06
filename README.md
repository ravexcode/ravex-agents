# Ravex Agents

This is a personal agents orquestator, you can use it for testing or for personal use

## Requirements

- [Bun](https://bun.sh) 1.3.14 or later
- At least one of these CLIs, installed and signed in: [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex) or [OpenCode](https://opencode.ai)

Ravex Agents runs these CLIs with your existing sign-ins, so it needs no API keys of its own. A CLI that isn't installed is marked in its pane and the others keep working.

## Getting started

Start the app from the project you want the agents to work on:

```sh
bun install
bun run start
```

Each provider has its own pane and keeps its own conversation until you quit the app. Sending to `All` runs the prompt on every provider at once, which uses quota on each of them.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt to the current target |
| `Tab` / `Shift+Tab` | Change the target: All, Claude, Codex or OpenCode |
| `Esc` | Cancel the current target's running turn |
| `Ctrl+E` | Switch between read-only and edit mode |
| `Ctrl+C` | Stop all agents and quit |

In `bun run dev`, `Ctrl+C` closes the app and the file watcher keeps running, so press it again to stop the watcher.

## Permission modes

The app starts in read-only mode. The mode applies from the next prompt you send, and never bypasses a CLI's approvals.

| Provider | Read-only | Edit |
| --- | --- | --- |
| Claude | `--permission-mode dontAsk`: denies anything your Claude settings don't already allow | `--permission-mode acceptEdits`: allows file edits |
| Codex | `read-only` sandbox | `workspace-write` sandbox |
| OpenCode | An allowlist agent with only read, search and list tools, which also denies `.env` files | The built-in `build` agent, which **allows the shell by default** |

Edit mode isn't equally strict across providers. OpenCode can run shell commands unless your OpenCode config restricts them.

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Run the app and restart it when files change |
| `bun run start` | Run the app |
| `bun test` | Run the tests |
| `bun run typecheck` | Type-check the project |

## Adding a provider

Add an adapter in `src/providers/` that implements `Provider` from `types.ts`, then register it in `index.ts`. An adapter defines how to invoke the CLI and how to translate its JSONL output into provider events. You also need to add its ID to `ProviderId`.
