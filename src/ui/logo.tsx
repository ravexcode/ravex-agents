import { LOGO_COLOR } from "./theme.ts"

// The mark from ravexcode.com/favicon.svg, drawn with Braille dots so its curves survive.
const LARGE = [
  "                                                           ⢀⣴⠃",
  "                                                          ⣰⣿⠇",
  "⣀⣀⣤⣤⣤⣤⣶⣶⣦⣤⣤⣤⣤⣤⣤⣄⣀⣀⣀                  ⢀⣠⡄                ⣠⣾⣿⠏",
  "⠉⠉⠉⠉⠉⠉⠛⠛⠿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣄⣀         ⢀⣴⣿⡟               ⣠⣾⣿⣿⠋",
  "           ⠈⠉⠛⠛⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⣀⣀⣀⣀⣠⣾⣿⣿⣿⠁            ⣀⣴⣾⣿⣿⡿⠁",
  "                  ⠉⠛⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇         ⢀⣠⣴⣾⣿⣿⣿⡿⠋",
  "                      ⠙⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄   ⢀⣀⣤⣴⣾⣿⣿⣿⣿⣿⡿⠋",
  "                   ⢀⣀⣠⣤⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠉",
  "               ⣀⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠟⠋",
  "            ⢀⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠿⠛⠋⠉",
  "          ⣠⣶⣿⣿⣿⣿⣿⣿⣿⠿⠛⠋⠉  ⠙⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣄",
  "        ⢀⣼⣿⣿⣿⣿⡿⠟⠋⠁        ⢘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣤⣀",
  "       ⣰⣿⣿⣿⡿⠛⠁            ⣼⣿⣿⡿⠟⠋⠉⠛⠛⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣦⣤⣀⣀",
  "     ⢀⣾⣿⣿⠟⠉              ⣸⣿⡿⠋        ⠈⠙⠻⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⣤⣄⣀⣀⣀",
  "    ⢠⣿⣿⠟⠁               ⢰⠟⠋               ⠈⠉⠙⠛⠛⠛⠛⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠟⠛⠋",
  "   ⢠⣿⠟⠁",
  "   ⡿⠃",
]
const SMALL = [
  "                                 ⣰⠃",
  "⣠⣤⣤⣴⣦⣤⣤⣤⣤⣤⣀⣀⡀       ⢀⣠         ⣠⣾⠏",
  "    ⠈⠉⠛⠻⠿⢿⣿⣿⣿⣿⣶⣤⣀⣀⣀⣴⣿⡏      ⢀⣠⣾⡿⠋",
  "          ⠈⠙⠻⣿⣿⣿⣿⣿⣿⣿⣿⡀   ⣀⣤⣶⣿⣿⠟⠁",
  "         ⢀⣀⣤⣤⣾⣿⣿⣿⣿⣿⣿⣿⣿⣶⣿⣿⣿⣿⡿⠋⠁",
  "       ⣠⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠿⠛⠋⠁",
  "     ⣠⣿⣿⡿⠟⠋⠉  ⠈⣿⣿⣿⣿⣿⣿⣿⣿⣦⣄⡀",
  "   ⢀⣾⡿⠟⠉      ⢰⣿⠟⠉⠉⠙⠻⢿⣿⣿⣿⣿⣿⣶⣦⣤⣀⡀",
  "  ⢠⡿⠋        ⠠⠟⠁       ⠉⠙⠛⠛⠻⠿⠿⠿⠿⠿⠿⠗⠒",
  " ⢠⠟",
]

const width = (lines: string[]) => Math.max(...lines.map((line) => line.length))

export interface LogoProps {
  width: number
  height: number
  /** The lines the screen keeps for itself, which the logo must stay out of. */
  fixedLines: number
  /** The lines at the top of those. */
  topLines: number
}

/** Drawn first, so that everything else on the screen sits on top of it. */
export function Logo({ width: screenWidth, height, fixedLines, topLines }: LogoProps) {
  const free = height - fixedLines
  const lines = [LARGE, SMALL].find((art) => art.length <= free && width(art) + 2 <= screenWidth)
  if (!lines) return null

  return (
    <box
      position="absolute"
      left={Math.floor((screenWidth - width(lines)) / 2)}
      top={topLines + Math.floor((free - lines.length) / 2)}
    >
      <text fg={LOGO_COLOR} wrapMode="none">
        {lines.join("\n")}
      </text>
    </box>
  )
}
