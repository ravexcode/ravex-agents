import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TeamSnapshot } from "./persistence.ts"

export interface ArchivedConversation {
  id: string
  title: string
  savedAt: number
  tasks: number
}

interface ArchiveFile extends ArchivedConversation {
  snapshot: TeamSnapshot
}

/** Conversations set aside by /new or /resume. One file each, so a bad one can't lose the others. */
export class ConversationArchive {
  readonly #dir: string
  #lastId = 0

  constructor(dir: string) {
    this.#dir = dir
  }

  #path(id: string): string {
    return join(this.#dir, `${id}.json`)
  }

  save(title: string, snapshot: TeamSnapshot): void {
    mkdirSync(this.#dir, { recursive: true })
    const savedAt = Date.now()
    // Two can be saved within the same millisecond.
    this.#lastId = Math.max(savedAt, this.#lastId + 1)
    const id = String(this.#lastId)
    const file: ArchiveFile = { id, title, savedAt, tasks: snapshot.board.tasks.length, snapshot }
    writeFileSync(this.#path(id), JSON.stringify(file))
  }

  /** The most recent first. Files that can't be read are left out, and stay on disk. */
  list(): ArchivedConversation[] {
    let names: string[]
    try {
      names = readdirSync(this.#dir)
    } catch {
      return []
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .flatMap((name): ArchivedConversation[] => {
        const file = this.#read(name.slice(0, -".json".length))
        if (!file) return []
        const { id, title, savedAt, tasks } = file
        return [{ id, title, savedAt, tasks }]
      })
      .sort((a, b) => b.savedAt - a.savedAt || Number(b.id) - Number(a.id))
  }

  load(id: string): TeamSnapshot | undefined {
    return this.#read(id)?.snapshot
  }

  remove(id: string): void {
    rmSync(this.#path(id), { force: true })
  }

  #read(id: string): ArchiveFile | undefined {
    try {
      const file = JSON.parse(readFileSync(this.#path(id), "utf8")) as ArchiveFile
      return Array.isArray(file.snapshot?.board?.tasks) && file.id === id ? file : undefined
    } catch {
      return undefined
    }
  }
}
