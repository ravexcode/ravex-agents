export const MAX_RESULT_LENGTH = 20_000

export interface ParsedBlock {
  /** The message without the block. */
  text: string
  data?: unknown
  error?: string
}

/**
 * Reads a fenced JSON block, normally the one that ends the message. Models
 * sometimes add a closing remark after it, so a later block also counts if it
 * sits on its own lines and holds valid JSON, which excludes most quoted examples.
 */
export function parseBlock(message: string, tag: string): ParsedBlock | null {
  const trailing = new RegExp("```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```\\s*$").exec(message)
  if (trailing) {
    const text = message.slice(0, trailing.index).trimEnd()
    try {
      return { text, data: JSON.parse(trailing[1] ?? "") }
    } catch {
      return { text, error: `The ${tag} block isn't valid JSON.` }
    }
  }

  const standalone = new RegExp("^```" + tag + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```[ \\t]*$", "gm")
  const last = [...message.matchAll(standalone)].at(-1)
  if (!last) return null
  try {
    const data: unknown = JSON.parse(last[1] ?? "")
    const before = message.slice(0, last.index).trimEnd()
    const after = message.slice(last.index + last[0].length).trim()
    return { text: [before, after].filter(Boolean).join("\n\n"), data }
  } catch {
    return null
  }
}

export function truncateResult(output: string): string {
  return output.length > MAX_RESULT_LENGTH
    ? `${output.slice(0, MAX_RESULT_LENGTH)}\n[Truncated: this was over ${MAX_RESULT_LENGTH} characters.]`
    : output
}
