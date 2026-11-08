const MAX_DETAIL_LENGTH = 80

// The CLIs' output is untrusted and versioned independently of this project,
// so parsers read it loosely and ignore anything they don't recognize.
export type JsonObject = Record<string, any>

export function parseJsonObject(line: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null ? (value as JsonObject) : null
  } catch {
    return null
  }
}

export function truncateDetail(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim()
  return singleLine.length > MAX_DETAIL_LENGTH
    ? `${singleLine.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : singleLine
}

/** Summarizes a tool's input by its first non-empty string value. */
export function summarizeInput(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const first = Object.values(input).find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  )
  return first === undefined ? undefined : truncateDetail(first)
}
