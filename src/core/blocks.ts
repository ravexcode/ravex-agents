export const MAX_RESULT_LENGTH = 20_000

export interface ParsedBlock {
  /** The message without the block. */
  text: string
  data?: unknown
  error?: string
}

/**
 * Reads a fenced JSON block from the end of a message. Only a block that ends
 * the message counts, so an agent can discuss or quote the format safely.
 */
export function parseTrailingBlock(message: string, tag: string): ParsedBlock | null {
  const pattern = new RegExp("```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```\\s*$")
  const match = pattern.exec(message)
  if (!match) return null

  const text = message.slice(0, match.index).trimEnd()
  try {
    return { text, data: JSON.parse(match[1] ?? "") }
  } catch {
    return { text, error: `The ${tag} block isn't valid JSON.` }
  }
}

export function truncateResult(output: string): string {
  return output.length > MAX_RESULT_LENGTH
    ? `${output.slice(0, MAX_RESULT_LENGTH)}\n[Truncated: this was over ${MAX_RESULT_LENGTH} characters.]`
    : output
}
