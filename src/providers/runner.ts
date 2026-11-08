import type { Provider, ProviderEvent, TurnRequest } from "./types.ts"

const KILL_GRACE_MS = 2000
// A grandchild can keep a pipe open after the CLI exits, so don't wait on it forever.
const PIPE_DRAIN_MS = 1000
const STDERR_TAIL_LENGTH = 2000

export type TurnStatus = "done" | "failed" | "cancelled"

export interface TurnResult {
  status: TurnStatus
  /** Why the turn failed, when the provider didn't report it through an event. */
  message?: string
}

export type RunTurn = (
  provider: Provider,
  request: TurnRequest,
  onEvent: (event: ProviderEvent) => void,
  signal: AbortSignal,
) => Promise<TurnResult>

async function readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }

  buffer += decoder.decode()
  if (buffer) onLine(buffer)
}

async function readTail(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let tail = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) return tail
    tail = (tail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_LENGTH)
  }
}

export const runTurn: RunTurn = async (provider, request, onEvent, signal) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    proc = Bun.spawn([provider.binary, ...provider.buildArgs(request)], {
      cwd: request.cwd,
      // OpenCode works in $PWD rather than in its real directory.
      env: { ...process.env, PWD: request.cwd, ...provider.buildEnv?.(request) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    return { status: "failed", message: `Could not start ${provider.binary}: ${String(error)}` }
  }

  let killTimer: Timer | undefined
  const terminate = () => {
    proc.kill()
    killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS)
  }
  if (signal.aborted) terminate()
  else signal.addEventListener("abort", terminate, { once: true })

  let sawFatalError = false
  let sawError = false
  const stdout = proc.stdout.getReader()
  const stderr = proc.stderr.getReader()

  const stdoutDone = readLines(stdout, (line) => {
    // Being killed can surface as an error, such as a dropped connection.
    if (signal.aborted) return

    for (const event of provider.parseLine(line)) {
      if (event.type === "error") {
        sawError = true
        sawFatalError ||= event.fatal
      }
      onEvent(event)
    }
  })
  let stderrTail = ""
  const stderrDone = readTail(stderr).then((tail) => {
    stderrTail = tail
  })

  const exitCode = await proc.exited
  clearTimeout(killTimer)
  signal.removeEventListener("abort", terminate)

  await Promise.race([Promise.all([stdoutDone, stderrDone]), Bun.sleep(PIPE_DRAIN_MS)])
  void stdout.cancel().catch(() => {})
  void stderr.cancel().catch(() => {})

  if (signal.aborted) return { status: "cancelled" }
  if (exitCode === 0 && !sawFatalError) return { status: "done" }

  return {
    status: "failed",
    message: sawError
      ? undefined
      : stderrTail.trim() || `${provider.binary} exited with code ${exitCode}`,
  }
}
