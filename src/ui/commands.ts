export type CommandName = "new" | "resume" | "agent" | "effort" | "skills" | "team" | "tasks" | "mode" | "settings" | "help" | "quit"

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
  { name: "effort", args: "[level]", description: "Choose how hard the current agent thinks" },
  { name: "skills", description: "Browse your skills. /name uses one" },
  { name: "team", description: "Create, edit or delete agents" },
  { name: "tasks", description: "Open the task list" },
  { name: "mode", args: "[edit|read-only]", description: "Switch between read-only and edit" },
  { name: "settings", description: "Open the settings" },
  { name: "help", description: "List the commands" },
  { name: "quit", aliases: ["exit"], description: "Stop everything and quit" },
]

export interface SkillSummary {
  name: string
  description: string
}

export type SlashInput = { command: Command; args: string } | { skill: string; args: string } | { unknown: string }

/** What the menu offers. Commands come first, and win when a skill has the same name. */
export type Offer = (Command & { skill?: false }) | { name: string; args: string; description: string; skill: true }

/**
 * Undefined means it's an ordinary message, as with a path like /etc/hosts. A
 * message that starts with a space is never a command, whatever comes next.
 */
export function parseSlash(text: string, skills: SkillSummary[] = []): SlashInput | undefined {
  const match = /^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(text.trimEnd())
  if (!match) return undefined
  const name = (match[1] ?? "").toLowerCase()
  const args = (match[2] ?? "").trim()
  const command = COMMANDS.find((candidate) => candidate.name === name || candidate.aliases?.includes(name))
  if (command) return { command, args }
  return skills.some((skill) => skill.name === name) ? { skill: name, args } : { unknown: name }
}

/** What to offer for what's in the prompt, while only a name is being typed. */
export function commandMatches(text: string, skills: SkillSummary[] = []): Offer[] {
  const match = /^\/([\w:-]*)$/.exec(text)
  if (!match) return []
  const typed = (match[1] ?? "").toLowerCase()
  const commands = COMMANDS.filter((command) =>
    [command.name, ...(command.aliases ?? [])].some((name) => name.startsWith(typed)),
  )
  const taken = new Set(COMMANDS.flatMap((command) => [command.name as string, ...(command.aliases ?? [])]))
  const offered = skills
    .filter((skill) => !taken.has(skill.name) && skill.name.startsWith(typed))
    .map((skill): Offer => ({ name: skill.name, args: "[request]", description: skill.description, skill: true }))
  return [...commands, ...offered]
}
