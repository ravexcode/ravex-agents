import type { Provider, ProviderId } from "./types.ts"

const COMMAND_TIMEOUT_MS = 15_000

export type ListModels = (provider: ProviderId) => Promise<string[]>

/** Shares a list while it loads and afterwards, so that only a failure is retried. */
export function createModelCatalog(providers: Provider[]): ListModels {
  const cache = new Map<ProviderId, Promise<string[]>>()
  return (id) => {
    const cached = cache.get(id)
    if (cached) return cached
    const list = providers.find((provider) => provider.id === id)?.listModels?.() ?? Promise.resolve([])
    cache.set(id, list)
    list.catch(() => cache.delete(id))
    return list
  }
}

/** Runs a read-only CLI command and returns its output. */
export async function readCommand(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: COMMAND_TIMEOUT_MS,
  })
  const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with code ${exitCode}`)
  return output
}

export function parseCodexModels(output: string): string[] {
  const data = JSON.parse(output) as { models?: { slug?: unknown; visibility?: unknown }[] }
  return (data.models ?? []).flatMap((model) =>
    model.visibility === "list" && typeof model.slug === "string" ? [model.slug] : [],
  )
}

/** The levels of that model, or of any model when it's using the CLI's default. */
export function parseCodexEfforts(output: string, model?: string): string[] {
  const data = JSON.parse(output) as {
    models?: { slug?: unknown; visibility?: unknown; supported_reasoning_levels?: { effort?: unknown }[] }[]
  }
  const models = (data.models ?? []).filter((candidate) =>
    model ? candidate.slug === model : candidate.visibility === "list",
  )
  const levels = models.flatMap((candidate) =>
    (candidate.supported_reasoning_levels ?? []).flatMap((level) => (typeof level.effort === "string" ? [level.effort] : [])),
  )
  return [...new Set(levels)]
}

export type ListEfforts = (provider: ProviderId, model?: string) => Promise<string[]>

/** Reading them can take seconds, and they don't change while it's open. */
export function createEffortCatalog(providers: Provider[]): ListEfforts {
  const cache = new Map<string, Promise<string[]>>()
  return (id, model) => {
    const key = `${id}/${model ?? ""}`
    const cached = cache.get(key)
    if (cached) return cached
    const list = providers.find((provider) => provider.id === id)?.listEfforts?.(model) ?? Promise.resolve([])
    cache.set(key, list)
    list.catch(() => cache.delete(key))
    return list
  }
}

export function parseOpenCodeModels(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/"))
}
