# Ravex Agents

A team of agents with an orchestrator, in your terminal. You create agents with their own name, provider, model, skills and tools, then give the orchestrator a goal. It proposes a plan, and once you approve it, the team works through a shared board and a group room.

It runs on the CLIs you already have installed and signed in: [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex/cli) and [OpenCode](https://opencode.ai). You don't need all of them. An agent whose CLI is missing shows as not installed and gets no tasks.

## Requirements

- [Bun](https://bun.sh) 1.3 or later
- At least one of the CLIs above in your `PATH`
- Codex needs the folder to be a Git repository

## Getting started

```sh
bun install
bun run dev
```

For a standalone executable (Linux x64 with glibc):

```sh
bun run build
./dist/ravex-agents
```

It works on the folder you open it from.

## How it works

1. You write a goal in the orchestrator's conversation.
2. The orchestrator can read the project, but it only plans. It knows each member's tools and skills, and proposes tasks.
3. **Nothing runs until you approve.** You can approve, type changes so it plans again, discard the plan, or reassign tasks.
4. Tasks start once their dependencies finish, and receive their results and comments.
5. If something fails or gets blocked, its dependents wait and the orchestrator proposes what to do. That plan needs your approval too.
6. When everything finishes, the orchestrator gives you a summary.

Board rules:

| Rule | Limit |
|---|---|
| Agents working at once | 4 |
| Tasks per agent at once | 1 |
| Tasks editing at once | 1, because everyone shares the folder |
| Tasks per goal | 12 |
| Replans per goal | 3 |
| Rounds of changes per review | 2 |

## Keys

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Switch conversation: orchestrator, room or an agent |
| `Enter` on an empty prompt | Approve the proposed plan, or continue paused work |
| `Esc` | Cancel what the view is doing. On a plan, discard it. On a pause, pressing it twice closes the goal |
| `PgUp` / `PgDn` | Scroll the conversation |
| `Ctrl+T` | Tasks: `↑`/`↓` move, `Enter` opens the detail, `r` reassigns |
| `Ctrl+P` / `F2` | Settings: create an agent, open the team or switch the session mode |
| `Ctrl+G` | Team: `n` new, `e` edit, `d` delete, `o` make orchestrator |
| `Ctrl+E` | Switch the session between read-only and edit |
| `Ctrl+C` | Stop everything and quit |

`Ctrl+Shift+P` also opens the settings if your terminal passes it on. Many terminals and editors keep it for their own command palette, so use `Ctrl+P` or `F2` there.

## Your team

Press `Ctrl+G`, then `n`, or choose **New agent** in the settings, to create an agent. Each one has a name, a description that tells the orchestrator what to assign to it, a provider and model, skills, tools and instructions.

There's a built-in `Lead`, which is the default orchestrator, and one agent per provider. You can edit them all: that saves a copy that overrides the original, and deleting the copy restores it.

Agents are saved in two places, and project agents win when IDs match. An older `agents.json` keeps working, and its `subagents` field is ignored.

| Where | File |
|---|---|
| Global | `$XDG_CONFIG_HOME/ravex-agents/agents.json` (`~/.config` by default) |
| Project | `.ravex/agents.json` |

### Models

The model list filters as you type, and accepts a name that isn't listed.

| CLI | Where the models come from |
|---|---|
| Claude | It has no command to list them, so it offers the aliases `fable`, `opus`, `sonnet` and `haiku` |
| Codex | `codex debug models`, only the ones it marks as selectable |
| OpenCode | `opencode models` |

### Skills

A skill is a folder with a `SKILL.md` file, the same format the CLIs use. The form lists every skill it finds, so an agent can use one from another CLI's folder. To write your own, add it to `.ravex/skills/<name>/SKILL.md` or `~/.config/ravex-agents/skills/<name>/SKILL.md`.

It looks in these folders, in this order, and the first skill with a given name wins:

- In the project: `.ravex/skills`, `.agents/skills`, `.claude/skills`, `.opencode/skills`
- In your home: `~/.config/ravex-agents/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.config/opencode/skills`

The skills you choose go into the agent's instructions on every turn, up to 60,000 characters in total. Past that, the agent is told which file to read. Once you choose skills for an agent, it no longer sees the others its CLI would find. An agent that never chose keeps what its CLI finds.

### Tools

Every agent can read the project. Beyond that, you choose:

| Tool | Claude | Codex | OpenCode |
|---|---|---|---|
| Edit files | Yes | Yes, through its sandbox | Yes |
| Run commands | Yes | Always on, limited by its sandbox | Yes |
| Search the web | Yes | Yes | Yes |
| MCP servers | Yes | Always on | Yes |

A tool that's off is removed, not just discouraged. Choosing tools also takes away everything else the CLI offers, such as starting its own subagents. An agent with neither edits nor commands can't change anything, and the orchestrator can't give it an editing task.

With commands on, Claude can run any command in edit mode without asking. Only give that tool to agents you'd trust with your shell.

## Cowork

**Board.** An agent ends its task with a `ravex-task` block to say it's done, blocked or ready for review, and can leave a comment. Without one, its final message counts as the result. If the task has a reviewer, they approve or ask for changes, and a review with no verdict never counts as an approval. A task's detail shows its comments, result and conversation, and you can add your own comments.

**Room.** A conversation shared with the team, which also shows board events. An agent only replies if you mention it with `@id`, so that a message doesn't spend everyone's quota. Agents can mention each other, up to 6 chained replies per message. Room turns are always read-only: changes to files go through tasks.

These CLIs work in turns, so agents talk between turns: they can't interrupt each other or converse in the middle of a run.

## Permissions

The session always starts read-only, and approving a plan doesn't grant permissions. A turn's real mode is the lowest of those that apply:

| Turn | Mode |
|---|---|
| Orchestrator, reviewer or room | Always read-only |
| Task without `edits` | Always read-only |
| Task with `edits` | The lower of `Ctrl+E` and what the agent's tools allow |
| Direct chat with an agent | The same, and read-only while another agent is editing |

How each CLI enforces it:

| CLI | Read-only | Edit |
|---|---|---|
| Claude | `--permission-mode dontAsk` | `--permission-mode acceptEdits` |
| Codex | `sandbox_mode="read-only"` | `sandbox_mode="workspace-write"` |
| OpenCode | An agent limited to reading and searching, with no access to `.env` | The `build` agent, or one with the tools you chose |

In read-only mode, Claude can still run commands that change nothing, such as `ls`, unless the agent has commands turned off. Your own Claude Code rules also still apply, so review them if they're broad.

## State

The board, room and sessions are saved in `$XDG_STATE_HOME/ravex-agents/<project>/` (`~/.local/state` by default), and nothing is added to your repository. On reopening, tasks that were running go back to pending, marked as interrupted, and don't start by themselves: `Enter` continues them. The session's mode isn't saved, so it returns to read-only.

## Scripts

| Script | Action |
|---|---|
| `bun run dev` | Run with automatic reload |
| `bun run start` | Run without reload |
| `bun run build` | Compile `dist/ravex-agents` |
| `bun run typecheck` | Check types |
| `bun test` | Run the tests |

## Adding a provider

Create an adapter in `src/providers/` that implements `Provider`, and add it to `src/providers/index.ts` and to `ProviderId`. The runner, the team and the UI pick it up from there.
