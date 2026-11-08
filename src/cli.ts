import { statSync } from "node:fs"
import { resolve } from "node:path"

export const USAGE = `Usage: ravexcode [folder]

Opens Ravex Agents on a folder, or on the current one if you don't name it.

Options:
  -h, --help      Show this help
  -v, --version   Show the version`

export type CliAction = { kind: "open"; folder: string } | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string }

export function parseCli(args: string[], cwd: string): CliAction {
  const positional: string[] = []
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") return { kind: "help" }
    if (arg === "-v" || arg === "--version") return { kind: "version" }
    if (arg.startsWith("-")) return { kind: "error", message: `Unknown option: ${arg}` }
    positional.push(arg)
  }
  if (positional.length > 1) return { kind: "error", message: "Only one folder can be opened at a time." }

  const folder = resolve(cwd, positional[0] ?? ".")
  try {
    if (statSync(folder).isDirectory()) return { kind: "open", folder }
    return { kind: "error", message: `Not a folder: ${folder}` }
  } catch {
    return { kind: "error", message: `Folder not found: ${folder}` }
  }
}
