import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConversationArchive } from "./archive.ts"
import { EMPTY_BOARD } from "./board.ts"
import type { TeamSnapshot } from "./persistence.ts"

const snapshot: TeamSnapshot = { version: 1, board: EMPTY_BOARD, room: [], sessions: {}, entries: {} }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-archive-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("lists the most recent first, even within one millisecond", () => {
  const archive = new ConversationArchive(dir)
  archive.save("one", snapshot)
  archive.save("two", snapshot)
  archive.save("three", snapshot)
  expect(archive.list().map((conversation) => conversation.title)).toEqual(["three", "two", "one"])
})

test("loads and removes a conversation", () => {
  const archive = new ConversationArchive(dir)
  archive.save("one", snapshot)
  const id = archive.list()[0]?.id as string
  expect(archive.load(id)).toEqual(snapshot)
  archive.remove(id)
  expect(archive.load(id)).toBeUndefined()
  expect(archive.list()).toEqual([])
})

test("a bad file doesn't hide the others", () => {
  const archive = new ConversationArchive(dir)
  archive.save("one", snapshot)
  writeFileSync(join(dir, "broken.json"), "{nope")
  writeFileSync(join(dir, "other.json"), "{}")
  expect(archive.list().map((conversation) => conversation.title)).toEqual(["one"])
})

test("an archive that doesn't exist yet is empty", () => {
  expect(new ConversationArchive(join(dir, "missing")).list()).toEqual([])
})
