import { expect, test } from "bun:test"
import { runTurn } from "./runner.ts"
import type { Provider, ProviderEvent } from "./types.ts"

function scriptProvider(script: string): Provider {
  return {
    id: "claude",
    label: "Fake",
    binary: process.execPath,
    buildArgs: () => ["-e", script],
    parseLine: (line) => (line ? [{ type: "text-delta", text: line }] : []),
  }
}

async function run(provider: Provider, signal = new AbortController().signal) {
  const events: ProviderEvent[] = []
  const result = await runTurn(
    provider,
    { prompt: "hi", cwd: process.cwd(), mode: "read-only" },
    (event) => events.push(event),
    signal,
  )
  return { events, result }
}

test("streams lines, including split chunks and a final line without a newline", async () => {
  const { events, result } = await run(
    scriptProvider(`
      process.stdout.write("one\\ntw");
      await Bun.sleep(20);
      process.stdout.write("o\\nthree");
    `),
  )
  expect(result).toEqual({ status: "done" })
  expect(events).toEqual([
    { type: "text-delta", text: "one" },
    { type: "text-delta", text: "two" },
    { type: "text-delta", text: "three" },
  ])
})

test("reports stderr when a CLI fails without an error event", async () => {
  const { result } = await run(scriptProvider(`console.error("boom"); process.exit(3)`))
  expect(result).toEqual({ status: "failed", message: "boom" })
})

test("doesn't repeat stderr when the provider already reported the error", async () => {
  const provider: Provider = {
    ...scriptProvider(`console.log("x"); console.error("noisy log"); process.exit(1)`),
    parseLine: (line) => (line ? [{ type: "error", fatal: true, message: line }] : []),
  }
  const { result } = await run(provider)
  expect(result).toEqual({ status: "failed", message: undefined })
})

test("fails on a fatal event even when the CLI exits with 0", async () => {
  const provider: Provider = {
    ...scriptProvider(`console.log("x")`),
    parseLine: (line) => (line ? [{ type: "error", fatal: true, message: line }] : []),
  }
  expect((await run(provider)).result.status).toBe("failed")
})

test("passes the provider's environment to the process", async () => {
  const { events } = await run({
    ...scriptProvider(`console.log(process.env.RAVEX_TEST_VALUE)`),
    buildEnv: () => ({ RAVEX_TEST_VALUE: "from-provider" }),
  })
  expect(events).toEqual([{ type: "text-delta", text: "from-provider" }])
})

test("sets PWD to the turn's folder, because a CLI may trust it over the real one", async () => {
  const events: ProviderEvent[] = []
  await runTurn(
    scriptProvider("console.log(process.env.PWD)"),
    { prompt: "hi", cwd: "/tmp", mode: "read-only" },
    (event) => events.push(event),
    new AbortController().signal,
  )
  expect(events).toEqual([{ type: "text-delta", text: "/tmp" }])
})

test("reports a missing binary instead of throwing", async () => {
  const { result } = await run({ ...scriptProvider(""), binary: "ravex-does-not-exist" })
  expect(result.status).toBe("failed")
  expect(result.message).toContain("ravex-does-not-exist")
})

test("cancelling stops the process", async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = run(scriptProvider(`await Bun.sleep(30000)`), controller.signal)
  setTimeout(() => controller.abort(), 50)
  expect((await pending).result).toEqual({ status: "cancelled" })
  expect(Date.now() - started).toBeLessThan(5000)
})

test("ignores output produced after cancelling", async () => {
  const controller = new AbortController()
  const pending = run(
    scriptProvider(`
      process.on("SIGTERM", () => { console.log("connection lost"); process.exit(1) });
      console.log("before");
      await Bun.sleep(30000);
    `),
    controller.signal,
  )
  await Bun.sleep(300)
  controller.abort()
  const { events, result } = await pending
  expect(result.status).toBe("cancelled")
  expect(events).toEqual([{ type: "text-delta", text: "before" }])
})

test("force-kills a process that ignores SIGTERM", async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = run(
    scriptProvider(`process.on("SIGTERM", () => {}); console.log("ready"); await Bun.sleep(30000)`),
    controller.signal,
  )
  setTimeout(() => controller.abort(), 300)
  expect((await pending).result).toEqual({ status: "cancelled" })
  expect(Date.now() - started).toBeLessThan(6000)
}, 10000)
