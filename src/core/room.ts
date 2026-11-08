export const MAX_ROOM_REPLIES = 6
const CONTEXT_MESSAGES = 20

export interface RoomMessage {
  id: number
  kind: "user" | "agent" | "info" | "error"
  /** The agent who wrote it, for agent messages. */
  author?: string
  text: string
}

export interface Mentions {
  known: string[]
  unknown: string[]
}

// Skips emails, and package names such as @scope/name.
const MENTION = /(?<![\w@./-])@([a-z0-9][a-z0-9-]*)(?![\w/])/gi

export function parseMentions(text: string, ids: ReadonlySet<string>): Mentions {
  const found = [...new Set([...text.matchAll(MENTION)].map((match) => (match[1] ?? "").toLowerCase()))]
  return { known: found.filter((id) => ids.has(id)), unknown: found.filter((id) => !ids.has(id)) }
}

/** Board events are left out because they'd crowd out what people actually said. */
export function formatRoomContext(messages: RoomMessage[], limit = CONTEXT_MESSAGES): string {
  return messages
    .filter((message) => message.kind === "user" || message.kind === "agent")
    .slice(-limit)
    .map((message) => `${message.kind === "user" ? "user" : `@${message.author}`}: ${message.text}`)
    .join("\n")
}

/** Agents sometimes copy the "@id:" format they see in the context. */
export function stripOwnPrefix(reply: string, agentId: string): string {
  const prefix = `@${agentId}:`
  const trimmed = reply.trim()
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed
}

export function buildRoomPrompt(messages: RoomMessage[], agentId: string): string {
  return `Recent messages in the team room:\n${formatRoomContext(messages)}\n\nYou are @${agentId} and someone mentioned you. Reply to the room.`
}
