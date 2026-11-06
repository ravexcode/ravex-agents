# Ravex Agents

Un equipo de agentes con un orquestador, exclusivo de la terminal. Creas agentes eligiendo el proveedor y el modelo de cada uno, le das un objetivo al orquestador, este propone un plan y, cuando lo apruebas, el equipo trabaja en un tablero compartido y una sala de grupo.

Usa tus CLIs ya instaladas y autenticadas: [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex/cli) y [OpenCode](https://opencode.ai). No necesitas tenerlas todas; un agente de una CLI que falte aparece como no instalado y no recibe tareas.

## Requisitos

- [Bun](https://bun.sh) 1.3 o superior
- Al menos una de las CLIs anteriores en tu `PATH`
- Codex necesita que la carpeta sea un repositorio de Git

## Empezar

```sh
bun install
bun run dev
```

Para un ejecutable independiente (Linux x64 con glibc):

```sh
bun run build
./dist/ravex-agents
```

Trabaja sobre la carpeta desde la que lo abras.

## Cómo funciona

1. Escribes un objetivo en la conversación del orquestador.
2. El orquestador puede leer el proyecto, pero solo planifica. Recibe la lista del equipo y propone tareas.
3. **Nada se ejecuta hasta que apruebas.** Puedes aprobar, escribir cambios para que replanifique, descartar el plan o reasignar tareas.
4. Las tareas arrancan cuando sus dependencias terminan, y reciben sus resultados y comentarios.
5. Si algo falla o se bloquea, sus dependientes esperan y el orquestador propone qué hacer. Ese plan también requiere tu aprobación.
6. Al terminar todo, el orquestador te da un resumen.

Reglas del tablero:

| Regla | Límite |
|---|---|
| Agentes trabajando a la vez | 4 |
| Tareas por agente a la vez | 1 |
| Tareas que editan a la vez | 1, porque todos comparten la carpeta |
| Tareas por objetivo | 12 |
| Replanificaciones por objetivo | 3 |
| Rondas de cambios por revisión | 2 |

## Teclas

| Tecla | Acción |
|---|---|
| `Tab` / `Shift+Tab` | Cambia de conversación: orquestador, sala o un agente |
| `Enter` con el input vacío | Aprueba el plan propuesto, o continúa el trabajo en pausa |
| `Esc` | Cancela lo que corresponda a la vista. Sobre un plan, lo descarta. En pausa, dos veces cierra el objetivo |
| `Ctrl+T` | Panel de tareas: `↑`/`↓` mueve, `Enter` abre el detalle, `r` reasigna |
| `Ctrl+G` | Equipo: `n` nuevo, `e` editar, `d` borrar, `o` elegir orquestador |
| `Ctrl+E` | Cambia la sesión entre solo lectura y edición |
| `Ctrl+C` | Detiene todo y sale |

## Equipo

Hay un agente `Lead`, que es el orquestador por defecto, y uno por cada proveedor. Todos se pueden editar: se guarda una copia que los sobrescribe, y borrarla restaura el original.

El selector de modelos filtra mientras escribes y admite un nombre que no aparezca en la lista.

| CLI | De dónde salen los modelos |
|---|---|
| Claude | No tiene comando para listarlos, así que ofrece los alias `fable`, `opus`, `sonnet` y `haiku` |
| Codex | `codex debug models`, solo los que marca como seleccionables |
| OpenCode | `opencode models` |

Los agentes se guardan en dos sitios, y los del proyecto ganan si coincide el ID. Un `agents.json` anterior sigue funcionando, y su campo `subagents` se ignora.

| Dónde | Archivo |
|---|---|
| Global | `$XDG_CONFIG_HOME/ravex-agents/agents.json` (por defecto `~/.config`) |
| Proyecto | `.ravex/agents.json` |

## Cowork

**Tablero.** Un agente termina su tarea con un bloque `ravex-task` para informar de que está hecha, bloqueada o lista para revisar, además de poder dejar un comentario. Si no lo incluye, su mensaje final cuenta como resultado. Si la tarea tiene revisor, este aprueba o pide cambios, y una revisión sin veredicto nunca cuenta como aprobada. En el detalle de cada tarea puedes leer comentarios, resultado y conversación, y añadir tus propios comentarios.

**Sala.** Es una conversación compartida con el equipo, donde también aparecen los eventos del tablero. Un agente solo responde si lo mencionas con `@id`, para no gastar la cuota de todos por cada mensaje. Los agentes pueden mencionarse entre sí, con un límite de 6 respuestas encadenadas por mensaje. Los turnos de sala siempre son de solo lectura: los cambios en archivos pasan por tareas.

Estas CLIs funcionan por turnos, así que los agentes se comunican entre turnos: no se interrumpen ni conversan a mitad de una ejecución.

## Permisos

La sesión arranca siempre en solo lectura, y aprobar un plan no da permisos. El modo real de cada turno es el más bajo de los que apliquen:

| Turno | Modo |
|---|---|
| Orquestador, revisor o sala | Siempre solo lectura |
| Tarea sin `edits` | Siempre solo lectura |
| Tarea con `edits` | El más bajo entre `Ctrl+E` y el máximo del agente |
| Chat directo con un agente | Igual, y solo lectura si otro agente está editando |

Cómo se aplica en cada CLI:

| CLI | Solo lectura | Edición |
|---|---|---|
| Claude | `--permission-mode dontAsk` | `--permission-mode acceptEdits` |
| Codex | `sandbox_mode="read-only"` | `sandbox_mode="workspace-write"` |
| OpenCode | Agente propio limitado a leer y buscar, sin acceso a `.env` | Agente `build` |

`dontAsk` y `acceptEdits` aún pueden hacer lo que permitan tus propias reglas de Claude Code. Revísalas si usas reglas amplias.

## Estado

El tablero, la sala y las sesiones se guardan en `$XDG_STATE_HOME/ravex-agents/<proyecto>/` (por defecto `~/.local/state`), sin añadir nada a tu repositorio. Al reabrir, las tareas que estaban en marcha vuelven a pendientes marcadas como interrumpidas y no se relanzan solas: `Enter` las continúa. El modo de la sesión no se guarda, así que vuelve a solo lectura.

## Scripts

| Script | Acción |
|---|---|
| `bun run dev` | Ejecuta con recarga automática |
| `bun run start` | Ejecuta sin recarga |
| `bun run build` | Compila `dist/ravex-agents` |
| `bun run typecheck` | Comprueba los tipos |
| `bun test` | Ejecuta los tests |

## Añadir un proveedor

Crea un adaptador en `src/providers/` que implemente `Provider`, y añádelo a `src/providers/index.ts` y a `ProviderId`. El runner, el equipo y la UI lo tomarán desde ahí.
