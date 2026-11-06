import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { slugify } from "../agents/identity.ts"
import type { Entry, SavedSessions } from "./agent-pool.ts"
import type { Board } from "./board.ts"
import type { RoomMessage } from "./room.ts"

export interface TeamSnapshot {
  version: 1
  board: Board
  room: RoomMessage[]
  sessions: SavedSessions
  entries: Record<string, Entry[]>
}

export interface StatePersistence {
  save(snapshot: TeamSnapshot): void
}

export function defaultStatePath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 10)
  return join(stateHome, "ravex-agents", `${slugify(basename(cwd)) || "project"}-${hash}`, "state.json")
}

function isSnapshot(value: unknown): value is TeamSnapshot {
  const snapshot = value as Partial<TeamSnapshot> | null
  return (
    snapshot?.version === 1 &&
    Array.isArray(snapshot.board?.tasks) &&
    Array.isArray(snapshot.room) &&
    typeof snapshot.sessions === "object" &&
    typeof snapshot.entries === "object"
  )
}

export interface StateLoad {
  snapshot?: TeamSnapshot
  /** Why saved state couldn't be used. The file is kept aside. */
  error?: string
}

export class StateFile implements StatePersistence {
  readonly #path: string

  constructor(path: string) {
    this.#path = path
  }

  load(): StateLoad {
    if (!existsSync(this.#path)) return {}
    try {
      const data: unknown = JSON.parse(readFileSync(this.#path, "utf8"))
      if (!isSnapshot(data)) throw new Error("unknown format")
      return { snapshot: data }
    } catch (error) {
      const aside = `${this.#path}.corrupt`
      renameSync(this.#path, aside)
      const reason = error instanceof Error ? error.message : String(error)
      return { error: `Couldn't restore the saved state (${reason}). It was moved to ${aside}` }
    }
  }

  save(snapshot: TeamSnapshot): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(snapshot))
    renameSync(temporary, this.#path)
  }
}
