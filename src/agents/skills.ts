import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderId } from "../providers/types.ts"
import { slugify } from "./identity.ts"

// Each argument and variable a CLI receives is limited to about 128 KB on Linux.
const MAX_SKILL_CHARS = 60_000

export type SkillSource = "project" | "ravex" | "agents" | ProviderId

export interface Skill {
  /** What agents refer to it by: its title, after its plugin's name if it has one. */
  name: string
  description: string
  path: string
  /** Where it was found. Skills with the same title count as one. */
  sources?: SkillSource[]
}

interface SkillVersion {
  path: string
  description: string
  body: string
  sources: SkillSource[]
}

interface MergedSkill {
  name: string
  /** The names of its folders, which agents saved earlier may refer to it by. */
  folders: Set<string>
  /** One for each different text, in the order of the folders they came from. */
  versions: SkillVersion[]
}

export interface SkillInstructions {
  text: string
  missing: string[]
}

export interface SkillDir {
  path: string
  source: SkillSource
  /** Comes first in the skill's name, as in figma:figma-use, as Claude Code writes it. */
  plugin?: string
}

/** The account's synced skills, and the skills of each synced and installed plugin. */
function claudeManagedDirs(claude: string): SkillDir[] {
  const synced = listFolder(join(claude, "skills", "synced"))
    .filter((name) => !name.startsWith("."))
    .map((name): SkillDir => ({ path: join(claude, "skills", "synced", name), source: "claude" }))
  const syncedPlugins = listFolder(join(claude, "plugins", "synced")).flatMap((account) =>
    listFolder(join(claude, "plugins", "synced", account)).map(
      (plugin): SkillDir => ({ path: join(claude, "plugins", "synced", account, plugin, "skills"), source: "claude", plugin }),
    ),
  )
  return [...synced, ...syncedPlugins, ...installedPluginDirs(claude)]
}

function installedPluginDirs(claude: string): SkillDir[] {
  try {
    const { plugins } = JSON.parse(readFileSync(join(claude, "plugins", "installed_plugins.json"), "utf8")) as {
      plugins: Record<string, { installPath: string }[]>
    }
    return Object.entries(plugins).flatMap(([id, installs]) =>
      installs.map(({ installPath }): SkillDir => ({
        path: join(installPath, "skills"),
        source: "claude",
        plugin: id.split("@")[0] ?? id,
      })),
    )
  } catch {
    return []
  }
}

export function defaultSkillDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): SkillDir[] {
  const home = homedir()
  const config = env.XDG_CONFIG_HOME || join(home, ".config")
  return [
    { path: join(cwd, ".ravex", "skills"), source: "project" },
    { path: join(cwd, ".agents", "skills"), source: "project" },
    { path: join(cwd, ".claude", "skills"), source: "project" },
    { path: join(cwd, ".opencode", "skills"), source: "project" },
    { path: join(config, "ravex-agents", "skills"), source: "ravex" },
    { path: join(home, ".agents", "skills"), source: "agents" },
    { path: join(home, ".claude", "skills"), source: "claude" },
    { path: join(home, ".codex", "skills"), source: "codex" },
    { path: join(config, "opencode", "skills"), source: "opencode" },
    ...claudeManagedDirs(join(home, ".claude")),
    { path: join(home, ".codex", "skills", ".system"), source: "codex" },
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

/** A project's copy is meant to override, then each CLI's own suits it best, as it may name its tools. */
function versionFor(skill: MergedSkill, provider?: ProviderId): SkillVersion | undefined {
  const { versions } = skill
  return (
    versions.find((version) => version.sources.includes("project")) ??
    versions.find((version) => provider !== undefined && version.sources.includes(provider)) ??
    versions[0]
  )
}

/** Finds skills in the folders that the CLIs use, and joins the ones with the same title. */
export class SkillLibrary {
  readonly #dirs: SkillDir[]

  constructor(dirs: SkillDir[]) {
    this.#dirs = dirs
  }

  #scan(): MergedSkill[] {
    const skills = new Map<string, MergedSkill>()
    for (const { path: dir, source, plugin } of this.#dirs) {
      for (const folder of listFolder(dir)) {
        const path = join(dir, folder, "SKILL.md")
        if (!isFile(path)) continue
        try {
          const { meta, body } = splitFrontmatter(readFileSync(path, "utf8"))
          const title = (typeof meta.name === "string" && slugify(meta.name)) || folder
          const prefix = plugin ? `${plugin}:` : ""
          const name = `${prefix}${title}`
          const skill: MergedSkill = skills.get(name) ?? { name, folders: new Set(), versions: [] }
          skills.set(name, skill)
          skill.folders.add(`${prefix}${folder}`)

          const text = body.trim()
          const same = skill.versions.find((version) => version.body === text)
          if (same) {
            if (!same.sources.includes(source)) same.sources.push(source)
          } else {
            const description = typeof meta.description === "string" ? meta.description.trim() : ""
            skill.versions.push({ path, description, body: text, sources: [source] })
          }
        } catch {
          // A skill that can't be read isn't one that can be offered.
        }
      }
    }
    return [...skills.values()]
  }

  list(): Skill[] {
    return this.#scan()
      .map((skill): Skill => {
        const first = skill.versions[0] as SkillVersion
        const sources = [...new Set(skill.versions.flatMap((version) => version.sources))]
        return { name: skill.name, description: first.description, path: first.path, sources }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Skills go in the instructions, so an agent can use one from any CLI's folder. */
  resolve = (names: string[], provider?: ProviderId): SkillInstructions => {
    const available = this.#scan()
    const missing: string[] = []
    const sections: string[] = []
    let remaining = MAX_SKILL_CHARS

    for (const name of names) {
      const skill = available.find((candidate) => candidate.name === name) ?? available.find((candidate) => candidate.folders.has(name))
      const version = skill && versionFor(skill, provider)
      if (!version) {
        missing.push(name)
        continue
      }
      const folder = `Its files are in ${version.path.replace(/\/SKILL\.md$/, "")}.`
      if (version.body.length > remaining) {
        sections.push(`# Skill: ${name}\n${version.description}\nThis skill is too long to include here. Read ${version.path} before using it.`)
      } else {
        remaining -= version.body.length
        sections.push(`# Skill: ${name}\n${folder}\n\n${version.body}`)
      }
    }
    return { text: sections.join("\n\n"), missing }
  }
}
