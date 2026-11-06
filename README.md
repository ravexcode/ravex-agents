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

The tree on the left lists your agents, and the right side shows the selected agent's conversation. Selecting `All` sends the prompt to every top-level agent and shows them in columns, which uses quota on each of them.

Conversations last until you quit the app.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt to the selected agent |
| `Tab` / `Shift+Tab` | Select the next or previous agent |
| `Esc` | Cancel the selected agent's work, including its subagents |
| `Ctrl+N` | Create an agent |
| `Ctrl+O` | Edit the selected agent |
| `Ctrl+X` | Delete the selected agent, after confirming |
| `Ctrl+E` | Switch the session between read-only and edit mode |
| `Ctrl+C` | Stop all agents and quit |

In the agent form, `Tab` moves between fields, `←`/`→` change a choice, `↑`/`↓` and `Space` choose subagents, `Ctrl+S` saves and `Esc` cancels.

In `bun run dev`, `Ctrl+C` closes the app and the file watcher keeps running, so press it again to stop the watcher.

## Agents

An agent has a name, a description, a provider, an optional model, instructions, a maximum permission mode and a list of subagents. Press `Ctrl+N` and start from a blank form or a template: Cybersecurity, Design, Code reviewer, Tester or Researcher.

Claude, Codex and OpenCode are always available as built-in agents with no instructions. They can't be edited or deleted.

Agents are saved to one of two files, which you choose in the form:

| Save to | File | Marked in the tree |
| --- | --- | --- |
| Global | `$XDG_CONFIG_HOME/ravex-agents/agents.json`, by default under `~/.config` | No |
| Project | `.ravex/agents.json` in the folder where you started the app | `·p` |

A project agent replaces a global agent with the same ID. If a file is invalid, the app reports it, doesn't load its agents and refuses to save to it, so your file isn't overwritten.

Changing an agent's provider, model, instructions or subagents starts a new conversation with it.

### Instructions by provider

| Provider | How instructions are applied |
| --- | --- |
| Claude | Added to its system prompt with `--append-system-prompt` |
| Codex | Set as `developer_instructions` |
| OpenCode | Set as the agent's `prompt`, which OpenCode documents as a custom system prompt |

## Subagents

Assign subagents to an agent in its form, and they appear nested under it in the tree. An agent can only delegate to the subagents assigned to it, so an agent with none never delegates. You can also select a subagent and message it directly.

Subagents can use a different provider from their parent. When an agent delegates:

1. It ends its message with a `ravex-delegate` block that lists the tasks.
2. Each subagent starts a clean session that contains only its task. Delegated tasks don't share its direct conversation.
3. Once all of them finish, the parent resumes with each subagent's final message, including any failures.
4. The parent can delegate again or give its final answer.

An agent runs one turn at a time, so tasks for a busy agent wait in a queue. Each subagent is a separate CLI run that uses quota of its own.

| Limit | Value |
| --- | --- |
| Steps in a delegation chain | 3 |
| Delegation rounds per prompt | 5 |
| Tasks per round | 8 |
| Subagents running at once, per round | 4 |
| Characters in each result returned to the parent | 20,000 |

Pressing `Esc` on a parent stops its whole chain. Pressing it on a subagent stops only that subagent, and the parent receives `cancelled` as its result.

## Permission modes

The app starts in read-only mode. An agent's effective mode is the lowest of the session's mode, its own maximum and its parent's effective mode, so a subagent never has more access than the agent that called it. New agents default to a read-only maximum.

The mode applies from the next turn, and never bypasses a CLI's approvals.

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
