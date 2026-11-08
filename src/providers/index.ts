import { claude } from "./claude.ts"
import { codex } from "./codex.ts"
import { opencode } from "./opencode.ts"
import type { Provider } from "./types.ts"

export const providers: Provider[] = [claude, codex, opencode]
