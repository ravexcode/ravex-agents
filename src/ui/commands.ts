export type CommandName = "new" | "resume" | "agent" | "team" | "tasks" | "mode" | "settings" | "help" | "quit"

export interface Command {
  name: CommandName
  aliases?: string[]
  /** How its argument is written, if it takes one. */
  args?: string
  description: string
}

export const COMMANDS: Command[] = [
  { name: "new", aliases: ["clear"], description: "Start a new conversation. /resume brings this one back" },
  { name: "resume", description: "Go back to an earlier conversation" },
  { name: "agent", args: "[name]", description: "Talk to another agent, or change its model" },
  { name: "team", description: "Create, edit or delete agents" },
  { name: "tasks", description: "Open the task list" },
  { name: "mode", args: "[edit|read-only]", description: "Switch between read-only and edit" },
  { name: "settings", description: "Open the settings" },
  { name: "help", description: "List the commands" },
  { name: "quit", aliases: ["exit"], description: "Stop everything and quit" },
]

export type SlashInput = { command: Command; args: string } | { unknown: string }

/**
 * Undefined means it's an ordinary message, as with a path like /etc/hosts. A
 * message that starts with a space is never a command, whatever comes next.
 */
export function parseSlash(text: string): SlashInput | undefined {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  if (!match) return undefined
  const name = (match[1] ?? "").toLowerCase()
  const command = COMMANDS.find((candidate) => candidate.name === name || candidate.aliases?.includes(name))
  return command ? { command, args: (match[2] ?? "").trim() } : { unknown: name }
}

/** The commands to offer for what's in the prompt, while only a name is being typed. */
export function commandMatches(text: string): Command[] {
  const match = /^\/([\w-]*)$/.exec(text)
  if (!match) return []
  const typed = (match[1] ?? "").toLowerCase()
  return COMMANDS.filter((command) =>
    [command.name, ...(command.aliases ?? [])].some((name) => name.startsWith(typed)),
  )
}
