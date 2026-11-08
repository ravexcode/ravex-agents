import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { EMPTY_BOARD } from "./board.ts"
import { defaultStatePath, StateFile, type TeamSnapshot } from "./persistence.ts"

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-state-"))
  path = join(dir, "deep", "state.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const snapshot: TeamSnapshot = { version: 1, board: EMPTY_BOARD, room: [], sessions: {}, entries: {} }

test("saves and loads, creating folders and leaving no temporary file", () => {
  const file = new StateFile(path)
  expect(file.load()).toEqual({})
  file.save(snapshot)
  expect(file.load().snapshot).toEqual(snapshot)
  expect([...new Bun.Glob("*").scanSync(dirname(path))]).toEqual(["state.json"])
})

test("keeps a corrupt file aside and starts clean", () => {
  mkdirSync(dirname(path), { recursive: true })
  for (const content of ["{ oops", '{"version":99}']) {
    writeFileSync(path, content)
    const result = new StateFile(path).load()
    expect(result.snapshot).toBeUndefined()
    expect(result.error).toContain(".corrupt")
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe(content)
  }
})

test("state lives outside the project, separately per project", () => {
  const env = { XDG_STATE_HOME: "/state" }
  const one = defaultStatePath("/work/Mi App", env)
  expect(one).toMatch(/^\/state\/ravex-agents\/mi-app-[0-9a-f]{10}\/state\.json$/)
  expect(defaultStatePath("/other/Mi App", env)).not.toBe(one)
  expect(defaultStatePath("/p", { HOME: "/h" })).toContain(join(".local", "state", "ravex-agents"))
})
