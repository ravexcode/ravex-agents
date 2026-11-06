import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCli } from "./cli.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravex-cli-"))
  mkdirSync(join(dir, "sub"))
  writeFileSync(join(dir, "file.txt"), "")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("opens the current folder by default, and with a dot", () => {
  expect(parseCli([], dir)).toEqual({ kind: "open", folder: dir })
  expect(parseCli(["."], dir)).toEqual({ kind: "open", folder: dir })
})

test("opens relative and absolute folders", () => {
  expect(parseCli(["sub"], dir)).toEqual({ kind: "open", folder: join(dir, "sub") })
  expect(parseCli([join(dir, "sub")], "/")).toEqual({ kind: "open", folder: join(dir, "sub") })
  expect(parseCli([".."], join(dir, "sub"))).toEqual({ kind: "open", folder: dir })
})

test("refuses what it can't open", () => {
  expect(parseCli(["missing"], dir)).toMatchObject({ kind: "error", message: expect.stringContaining("not found") })
  expect(parseCli(["file.txt"], dir)).toMatchObject({ kind: "error", message: expect.stringContaining("Not a folder") })
  expect(parseCli(["a", "b"], dir)).toMatchObject({ kind: "error" })
  expect(parseCli(["--nope"], dir)).toEqual({ kind: "error", message: "Unknown option: --nope" })
})

test("answers help and version without opening anything", () => {
  expect(parseCli(["--help"], dir)).toEqual({ kind: "help" })
  expect(parseCli(["-v", "missing"], dir)).toEqual({ kind: "version" })
})
