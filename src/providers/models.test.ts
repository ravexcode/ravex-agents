import { expect, test } from "bun:test"
import { createModelCatalog, parseCodexModels, parseOpenCodeModels, readCommand } from "./models.ts"
import type { Provider } from "./types.ts"

test("lists only the Codex models it marks as selectable", () => {
  const output = JSON.stringify({
    models: [
      { slug: "gpt-6-sol", visibility: "list" },
      { slug: "gpt-internal", visibility: "hide" },
      { visibility: "list" },
    ],
  })
  expect(parseCodexModels(output)).toEqual(["gpt-6-sol"])
  expect(parseCodexModels("{}")).toEqual([])
})

test("rejects Codex output that isn't JSON", () => {
  expect(() => parseCodexModels("not json")).toThrow()
})

test("reads OpenCode's list and skips anything that isn't a model", () => {
  expect(parseOpenCodeModels("ollama/bonsai-2:2b\n\nsome notice\nopenai/gpt-5.5\n")).toEqual([
    "ollama/bonsai-2:2b",
    "openai/gpt-5.5",
  ])
})

test("readCommand returns output, and rejects on a failed or missing command", async () => {
  expect(await readCommand([process.execPath, "-e", 'console.log("ok")'])).toBe("ok\n")
  expect(readCommand([process.execPath, "-e", "process.exit(3)"])).rejects.toThrow("code 3")
  expect(() => readCommand(["ravex-does-not-exist"])).toThrow()
})

test("the catalog caches a list, but retries after a failure", async () => {
  let calls = 0
  const provider = {
    id: "codex",
    listModels: async () => {
      calls++
      if (calls === 1) throw new Error("no")
      return ["m"]
    },
  } as unknown as Provider
  const list = createModelCatalog([provider])
  expect(list("codex")).rejects.toThrow("no")
  await Bun.sleep(0)
  expect(await list("codex")).toEqual(["m"])
  expect(await list("codex")).toEqual(["m"])
  expect(calls).toBe(2)
})

test("the catalog is empty for a provider that can't list models", async () => {
  expect(await createModelCatalog([])("claude")).toEqual([])
})
