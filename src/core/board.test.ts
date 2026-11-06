import { describe, expect, test } from "bun:test"
import {
  EMPTY_BOARD,
  nextRuns,
  parsePlan,
  parseReview,
  parseWorkerReport,
  recoverBoard,
  type Board,
  type Task,
} from "./board.ts"

const workers = new Set(["a", "b"])
const block = (data: unknown) => `Here is the plan.\n\n\`\`\`ravex-plan\n${JSON.stringify(data)}\n\`\`\``
const item = (key: string, overrides: object = {}) => ({
  key,
  title: `Title ${key}`,
  description: `Do ${key}`,
  agent: "a",
  ...overrides,
})
const parse = (data: unknown, board: Board = EMPTY_BOARD) => parsePlan(block(data), { workers, board })

const task = (id: number, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `T${id}`,
  description: "d",
  assignee: `agent${id}`,
  dependsOn: [],
  edits: false,
  reviewRounds: 0,
  status: "todo",
  comments: [],
  ...overrides,
})

describe("parsePlan", () => {
  test("reads tasks and turns keys into task numbers", () => {
    const plan = parse({ tasks: [item("x"), item("y", { dependsOn: ["x"], edits: true, reviewer: "b" })] })
    expect(plan?.error).toBeUndefined()
    expect(plan?.text).toBe("Here is the plan.")
    expect(plan?.tasks).toMatchObject([
      { id: 1, status: "proposed", assignee: "a", dependsOn: [], edits: false },
      { id: 2, dependsOn: [1], edits: true, reviewer: "b" },
    ])
  })

  test("numbers tasks after the existing ones", () => {
    expect(parse({ tasks: [item("x")] }, { ...EMPTY_BOARD, nextTaskId: 9 })?.tasks[0]?.id).toBe(9)
  })

  test("accepts a closing remark after the block, without keeping the block", () => {
    const plan = parsePlan(`${block({ tasks: [item("x")] })}\n\nChoices I made: none.`, { workers, board: EMPTY_BOARD })
    expect(plan?.tasks.length).toBe(1)
    expect(plan?.text).toBe("Here is the plan.\n\nChoices I made: none.")
  })

  test("ignores what only quotes the format", () => {
    const options = { workers, board: EMPTY_BOARD }
    expect(parsePlan("Just an answer.", options)).toBeNull()
    expect(parsePlan("The format is\n```ravex-plan\n{...}\n```\nand so on.", options)).toBeNull()
    expect(parsePlan('  ```ravex-plan\n  {"tasks":[]}\n  ```\nIndented, as a quote.', options)).toBeNull()
  })

  test.each([
    ["bad JSON", "```ravex-plan\n{oops\n```", "isn't valid JSON"],
    ["no tasks", block({ tasks: [] }), "no tasks"],
    ["no list", block({ tasks: "x" }), "must be a list"],
    ["no title", block({ tasks: [item("x", { title: " " })] }), '"title"'],
    ["no description", block({ tasks: [item("x", { description: "" })] }), '"description"'],
    ["unknown agent", block({ tasks: [item("x", { agent: "ghost" })] }), "isn't an available"],
    ["unknown reviewer", block({ tasks: [item("x", { reviewer: "ghost" })] }), "isn't an available"],
    ["self review", block({ tasks: [item("x", { reviewer: "a" })] }), "its own assignee"],
    ["unknown key", block({ tasks: [item("x", { dependsOn: ["nope"] })] }), 'unknown key "nope"'],
    ["unfinished number", block({ tasks: [item("x", { dependsOn: [40] })] }), "isn't finished"],
    ["cycle", block({ tasks: [item("x", { dependsOn: ["y"] }), item("y", { dependsOn: ["x"] })] }), "cycle"],
    ["self dependency", block({ tasks: [item("x", { dependsOn: ["x"] })] }), "cycle"],
    ["bad retry", block({ tasks: [], retry: ["a"] }), '"retry"'],
    ["unknown retry", block({ tasks: [], retry: [7] }), "can't be retried"],
  ])("rejects %s", (_name, message, error) => {
    const plan = parsePlan(message, { workers, board: EMPTY_BOARD })
    expect(plan?.tasks).toEqual([])
    expect(plan?.error).toContain(error)
  })

  test("limits a goal to 12 tasks, counting the finished ones", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => item(`k${index}`))
    expect(parse({ tasks: eleven })?.error).toBeUndefined()
    const board = { ...EMPTY_BOARD, tasks: [task(1, { status: "done" }), task(2, { status: "done" })], nextTaskId: 3 }
    expect(parse({ tasks: eleven }, board)?.error).toContain("at most 12")
  })

  test("can retry unfinished tasks and depend on finished or retried ones", () => {
    const board = {
      ...EMPTY_BOARD,
      tasks: [task(1, { status: "done" }), task(2, { status: "failed" })],
      nextTaskId: 3,
    }
    const plan = parse({ tasks: [item("x", { dependsOn: [1, 2] })], retry: [2] }, board)
    expect(plan?.error).toBeUndefined()
    expect(plan?.retry).toEqual([2])
    expect(plan?.tasks[0]).toMatchObject({ id: 3, dependsOn: [1, 2] })
    expect(parse({ tasks: [], retry: [1] }, board)?.error).toContain("can't be retried")
  })
})

describe("nextRuns", () => {
  const ids = (runs: ReturnType<typeof nextRuns>) => runs.map((run) => run.task.id)

  test("only starts tasks whose dependencies are done", () => {
    const tasks = [task(1), task(2, { dependsOn: [1] }), task(3, { status: "done" }), task(4, { dependsOn: [3] })]
    expect(ids(nextRuns(tasks, new Map()))).toEqual([1, 4])
  })

  test("never gives an agent two tasks at once", () => {
    const tasks = [task(1, { assignee: "a" }), task(2, { assignee: "a" }), task(3, { assignee: "b" })]
    expect(ids(nextRuns(tasks, new Map()))).toEqual([1, 3])
    expect(ids(nextRuns([tasks[1]!], new Map([[9, "a"]])))).toEqual([])
  })

  test("runs read-only tasks in parallel, up to 4", () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(index + 1))
    expect(ids(nextRuns(tasks, new Map()))).toEqual([1, 2, 3, 4])
    const active = new Map([[1, "x"], [2, "y"], [3, "z"]])
    expect(ids(nextRuns(tasks.slice(3), active))).toEqual([4])
  })

  test("allows one editing task at a time, alongside read-only ones", () => {
    const tasks = [task(1, { edits: true }), task(2, { edits: true }), task(3)]
    expect(ids(nextRuns(tasks, new Map()))).toEqual([1, 3])

    const running = [task(1, { edits: true, status: "running" }), task(2, { edits: true }), task(3)]
    expect(ids(nextRuns(running, new Map([[1, "agent1"]])))).toEqual([3])
  })

  test("waits for an edit made outside of tasks", () => {
    expect(ids(nextRuns([task(1, { edits: true }), task(2)], new Map(), true))).toEqual([2])
  })

  test("dependents of a failed, blocked or cancelled task wait", () => {
    for (const status of ["failed", "blocked", "cancelled"] as const) {
      expect(nextRuns([task(1, { status }), task(2, { dependsOn: [1] })], new Map())).toEqual([])
    }
  })

  test("runs a review through the reviewer, without blocking edits", () => {
    const tasks = [task(1, { status: "review", reviewer: "r", edits: true }), task(2, { edits: true })]
    expect(nextRuns(tasks, new Map()).map((run) => [run.task.id, run.kind, run.agent])).toEqual([
      [1, "review", "r"],
      [2, "work", "agent2"],
    ])
  })
})

describe("parseWorkerReport", () => {
  const report = (data: object) => `Details.\n\`\`\`ravex-task\n${JSON.stringify(data)}\n\`\`\``

  test("a message without a block counts as a finished result", () => {
    expect(parseWorkerReport("All done.")).toEqual({ status: "done", text: "All done.", summary: "All done." })
  })

  test("reads every status and the optional fields", () => {
    expect(parseWorkerReport(report({ status: "blocked", summary: "Need a key", comment: "c", room: "@b hi" }))).toEqual({
      status: "blocked",
      text: "Details.",
      summary: "Need a key",
      comment: "c",
      room: "@b hi",
    })
    expect(parseWorkerReport(report({ status: "review", summary: "s" })).status).toBe("review")
  })

  test("an unknown status counts as done", () => {
    expect(parseWorkerReport(report({ status: "?" })).status).toBe("done")
  })
})

test("a worker's report also survives a closing remark", () => {
  const report = parseWorkerReport('Work.\n```ravex-task\n{"status":"blocked","summary":"Stuck"}\n```\nLet me know.')
  expect(report).toMatchObject({ status: "blocked", summary: "Stuck", text: "Work.\n\nLet me know." })
})

describe("parseReview", () => {
  test("reads a verdict", () => {
    const message = 'Looks fine.\n```ravex-review\n{"verdict":"approved","comment":"ok"}\n```'
    expect(parseReview(message)).toEqual({ verdict: "approved", text: "Looks fine.", comment: "ok" })
  })

  test("never assumes an approval", () => {
    expect(parseReview("Looks fine.").verdict).toBe("none")
    expect(parseReview('```ravex-review\n{"verdict":"maybe"}\n```').verdict).toBe("none")
  })
})

describe("recoverBoard", () => {
  test("interrupted tasks wait for the user, marked as interrupted", () => {
    const board = recoverBoard({ ...EMPTY_BOARD, phase: "running", tasks: [task(1, { status: "running" })] })
    expect(board.phase).toBe("paused")
    expect(board.tasks[0]?.status).toBe("todo")
    expect(board.tasks[0]?.comments[0]?.text).toContain("Interrupted")
  })

  test("keeps a proposal, and rests when everything finished", () => {
    expect(recoverBoard({ ...EMPTY_BOARD, phase: "planning", tasks: [task(1, { status: "proposed" })] }).phase).toBe("proposed")
    expect(recoverBoard({ ...EMPTY_BOARD, phase: "wrapping-up", tasks: [task(1, { status: "done" })] }).phase).toBe("idle")
  })
})
