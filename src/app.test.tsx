import { expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App } from "./app.tsx"

test("renders the title and quits on q", async () => {
  const setup = await testRender(<App />, { width: 40, height: 10 })

  try {
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Ravex Agents")

    await act(async () => {
      setup.mockInput.pressKey("q")
    })
    expect(setup.renderer.isDestroyed).toBe(true)
  } finally {
    setup.renderer.destroy()
  }
})
