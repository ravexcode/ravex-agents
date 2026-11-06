import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Each argument and variable a CLI receives is limited to about 128 KB on Linux.
const MAX_SKILL_CHARS = 60_000

export interface Skill {
  /** What agents refer to it by: the name of its folder. */
  name: string
  description: string
  path: string
}

export interface SkillInstructions {
  text: string
  missing: string[]
}

/** Earlier folders win when two skills share a name. */
export function defaultSkillDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir()
  const config = env.XDG_CONFIG_HOME || join(home, ".config")
  return [
    join(cwd, ".ravex", "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".opencode", "skills"),
    join(config, "ravex-agents", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(config, "opencode", "skills"),
  ]
}

function splitFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { meta: {}, body: content }
  try {
    const meta = Bun.YAML.parse(match[1] ?? "")
    return {
      meta: typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {},
      body: content.slice(match[0].length),
    }
  } catch {
    return { meta: {}, body: content.slice(match[0].length) }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function listFolder(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Finds skills in the folders that the CLIs use, which works across all of them. */
export class SkillLibrary {
  readonly #dirs: string[]

  constructor(dirs: string[]) {
    this.#dirs = dirs
  }

  list(): Skill[] {
    const skills = new Map<string, Skill>()
    for (const dir of this.#dirs) {
      for (const name of listFolder(dir)) {
        const path = join(dir, name, "SKILL.md")
        if (skills.has(name) || !isFile(path)) continue
        try {
          const { meta } = splitFrontmatter(readFileSync(path, "utf8"))
          skills.set(name, {
            name,
            description: typeof meta.description === "string" ? meta.description.trim() : "",
            path,
          })
        } catch {
          // A skill that can't be read isn't one that can be offered.
        }
      }
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Skills go in the instructions, so an agent can use one from any CLI's folder. */
  resolve = (names: string[]): SkillInstructions => {
    const available = new Map(this.list().map((skill) => [skill.name, skill]))
    const missing: string[] = []
    const sections: string[] = []
    let remaining = MAX_SKILL_CHARS

    for (const name of names) {
      const skill = available.get(name)
      if (!skill) {
        missing.push(name)
        continue
      }
      const { body } = splitFrontmatter(readFileSync(skill.path, "utf8"))
      const folder = `Its files are in ${skill.path.replace(/\/SKILL\.md$/, "")}.`
      if (body.length > remaining) {
        sections.push(`# Skill: ${name}\n${skill.description}\nThis skill is too long to include here. Read ${skill.path} before using it.`)
      } else {
        remaining -= body.length
        sections.push(`# Skill: ${name}\n${folder}\n\n${body.trim()}`)
      }
    }
    return { text: sections.join("\n\n"), missing }
  }
}
