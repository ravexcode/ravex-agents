import { expect, test } from "bun:test"
import { formatRoomContext, parseMentions, stripOwnPrefix, type RoomMessage } from "./room.ts"

const ids = new Set(["security", "design-lead"])

test("finds known and unknown mentions, without repeats", () => {
  expect(parseMentions("@Security and @design-lead, also @security and @nobody", ids)).toEqual({
    known: ["security", "design-lead"],
    unknown: ["nobody"],
  })
})

test("isn't fooled by emails or package names", () => {
  expect(parseMentions("write to me@security.com or install @security/pkg", ids).known).toEqual([])
})

test("removes a copied prefix, but only the agent's own", () => {
  expect(stripOwnPrefix(" @Security: hi @design", "security")).toBe("hi @design")
  expect(stripOwnPrefix("@design: hi", "security")).toBe("@design: hi")
})

test("gives agents what people said, without board events", () => {
  const messages: RoomMessage[] = [
    { id: 1, kind: "user", text: "hello" },
    { id: 2, kind: "info", text: "Task 1 started" },
    { id: 3, kind: "agent", author: "security", text: "hi" },
  ]
  expect(formatRoomContext(messages)).toBe("user: hello\n@security: hi")
  expect(formatRoomContext(messages, 1)).toBe("@security: hi")
})
