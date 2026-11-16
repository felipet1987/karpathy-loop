# karpathy-loop

Los dos loops de autoresearch como máquinas XState v5. A diferencia del repo de
Karpathy, aquí el ciclo lo corre la máquina y el agente (Claude Code en modo `claude -p`)
solo escribe checks y cambios.

- **Loop interno:** mejora `train.py` para bajar `val_loss`. Cada iteración: write checks
  → build → pass checks → entrenar → conservar o revertir.
- **Loop externo:** mejora `program.md`, el system prompt del investigador. Corre tandas
  del loop interno y conserva la versión que más baja `val_loss`.
- **Flujo por feature:** construye features pedidas en `features.md` de cualquier repo:
  write-checks → revisión humana → approve-checks → rondas → reporte, y un auto-loop que
  mejora `program.md` con el registro de rondas. Ver «Flujo por feature».

| Archivo            | Rol                                                            |
|--------------------|----------------------------------------------------------------|
| `prepare.py`       | fijo: datos, presupuesto de 20 s y `evaluar` (`val_loss`)      |
| `train.py`         | lo que cambia el investigador en la fase build                 |
| `checks/`          | checks que escribe el investigador; los corre la máquina       |
| `program.md`       | system prompt del investigador; lo reescribe el loop externo   |
| `meta-prompt.md`   | system prompt del meta-agente del loop externo                 |
| `src/nucleo/`      | máquinas XState, puertos y encargos; sin infraestructura       |
| `src/adaptadores/` | implementaciones de los puertos (git, TSV, uv, `claude -p`)    |
| `plugin/skills/`   | skills `kl:write-checks`, `kl:feature-builder`, `kl:auto-loop` |
| `src/cli.ts`       | punto de entrada y composition root: cablea los adaptadores     |

## Requisitos

- Node ≥ 24: corre TypeScript sin compilar (`erasableSyntaxOnly`).
- `uv`, para entrenar y correr los checks con el `numpy` de `pyproject.toml`.
- El CLI `claude`, autenticado. Solo hace falta para los loops reales, no para `npm test`.

## Uso

```bash
npm install
npm test                                   # núcleo con fakes y adaptadores locales, sin cuota
npm run typecheck
node src/cli.ts interno --iteraciones 10   # un loop interno real
node src/cli.ts externo --versiones 4 --iteraciones 8
```

| Flag            | `interno`        | `externo`        | Qué controla                          |
|-----------------|------------------|------------------|---------------------------------------|
| `--iteraciones` | 10               | 8 por tanda      | iteraciones del loop interno          |
| `--minutos`     | 15               | 10 por tanda     | tope de reloj del loop interno        |
| `--versiones`   | —                | 4                | versiones de `program.md` a probar    |
| `--tope-usd`    | sin tope         | sin tope, por tanda | gasto máximo; al alcanzarlo no empieza otra iteración |
| `--etiqueta`    | fecha `AAAAMMDDhhmm` (UTC) | ídem   | nombre del worktree y de la rama      |

| Variable                    | Por defecto       | Qué controla                            |
|-----------------------------|-------------------|-----------------------------------------|
| `KL_MODELO`                 | `claude-opus-5-5` | modelo de cada llamada a `claude -p`    |
| `KL_PRESUPUESTO_AGENTE_USD` | `2`               | tope de gasto por llamada (`--max-budget-usd`) |

Cada iteración real llama a Claude Code al menos dos veces (write checks y build) y
consume cuota. El repo tiene que estar sin cambios, ni siquiera archivos nuevos sin
seguimiento: las máquinas hacen `checkout` y `reset`, y `cli.ts` se niega a arrancar si
encuentra cambios.

## Qué deja cada corrida

- Los experimentos corren en worktrees bajo `.trabajo/<etiqueta>`, en la rama
  `autoresearch/<etiqueta>`. Los commits conservados quedan en esa rama.
- `interno` anota cada experimento en `.trabajo/<etiqueta>/results.tsv`.
- `externo` usa una etiqueta `<etiqueta>-v<n>` por tanda, anota en
  `meta/resultados-v<n>.tsv` y resume cada versión en `meta/historial.tsv`. Quita el
  worktree al terminar cada tanda; las ramas quedan.
- Las versiones conservadas de `program.md` se commitean en la rama actual
  (`program.md v<n>: ganancia …`).

## El ciclo del loop interno

| Estado              | Quién           | Qué pasa                                                  |
|---------------------|-----------------|-----------------------------------------------------------|
| `lineaBase`         | máquina         | entrena `train.py` sin cambios; es la marca a superar      |
| `escribiendoChecks` | agente          | decide UN cambio y escribe o ajusta `checks/*.py`          |
| `aislandoChecks`    | máquina         | exige que solo cambió `checks/` y lo pasa al index         |
| `construyendo`      | agente          | implementa el cambio en `train.py`                         |
| `verificando`       | máquina         | exige que fuera del index solo cambió `train.py`           |
| `corriendoChecks`   | máquina         | `uv run python` por check; si falla, vuelve a build con la salida |
| `entrenando`        | máquina         | commit de `train.py` + `checks/`, y `uv run train.py`      |
| `conservando` / `revirtiendo` | máquina | conserva el commit si bajó `val_loss`; si no, `reset`   |

Status que quedan en `results.tsv`:

| Status             | Significado                                                       |
|--------------------|-------------------------------------------------------------------|
| `keep`             | bajó `val_loss`; el commit queda en la rama (y sus checks también) |
| `discard`          | no bajó `val_loss`; se revirtió                                    |
| `crash`            | el entrenamiento falló, pasó de 60 s o no imprimió `val_loss`      |
| `fuera_de_alcance` | el agente tocó algo fuera de lo permitido en su fase; se deshizo   |
| `checks_fallidos`  | tras 3 intentos de build los checks no pasaron; se deshizo         |
| `fallo_agente`     | la llamada a `claude -p` falló; su costo igual se cuenta, se deshizo |

Límites: 15 min por llamada al agente, 60 s por check, 60 s por entrenamiento, y los
últimos 4000 caracteres de la salida de los checks vuelven al agente.

## Lo que la máquina garantiza y un prompt no

- El investigador no tiene shell: no puede entrenar, correr checks, hacer commits ni leer
  la evaluación.
- Al escribir checks solo puede tocar `checks/`; al construir, solo `train.py` (los checks
  quedan en el index, así se detecta si los debilita). Si no, `fuera_de_alcance`.
- Los checks los corre la máquina; sin pasarlos no hay commit ni entrenamiento
  (`checks_fallidos` tras 3 intentos).
- Si el meta-agente toca otro archivo o el bloque `<!-- protegido -->` de `program.md`,
  se revierte su cambio.
- Todas las tandas del loop externo parten del mismo commit, para comparar versiones
  de `program.md` en igualdad.
- `claude -p` y `uv run train.py` corren cada uno en su propio grupo de procesos. Un
  plazo vencido, un abort o Ctrl-C (que detiene el actor y aborta los `AbortSignal` de
  `Agente` y `Entrenador`) matan el grupo entero, con hijos y nietos.
- `claude -p` corre con `--setting-sources ""` y `--permission-mode dontAsk`: sin hooks
  ni `CLAUDE.md` del usuario, y solo con las herramientas de su fase.

## Flujo por feature (checks primero)

Convive con el autoresearch: en vez de bajar `val_loss`, construye features pedidas por
una persona en cualquier repo git (`--repo`, por defecto el actual).

```bash
node src/cli.ts feature checks <id> [--repo .]                       # write-checks
node src/cli.ts feature aprobar <id> [--repo .] [--rondas 5] [--tope-usd X]
node src/cli.ts feature mejorar [--repo .]                           # auto-loop
```

1. **Pedido.** Una sección `## <id>` en `features.md`, commiteada.
2. **write-checks.** Crea el worktree `.trabajo/feature-<id>` (rama `feature/<id>`) y la
   skill `kl:write-checks` escribe tests en `checks/<id>/` antes del código. Si toca algo
   fuera de esa carpeta, se descarta todo. Los checks quedan **sin commitear**.
3. **Revisar checks.** La persona los lee y los ajusta en el worktree. Decide ella.
4. **approve-checks.** `feature aprobar` commitea `checks/<id>/` (rechaza cambios fuera de
   la carpeta). Desde ese commit la carpeta queda bloqueada.
5. **Rondas.** La skill `kl:feature-builder` (un `claude -p` nuevo por ronda) cambia el
   código; la máquina corre los checks y el puntaje es cuántos pasan. Si sube, se
   conserva (commit); si no, se deshace y la salida de los checks llega a la ronda
   siguiente. Tocar `checks/` descarta la ronda. Termina cuando todos pasan, se agotan las
   rondas o se llega al tope de USD. Repetir `aprobar` sigue con más rondas.
6. **Registro de rondas y reporte.** `<repo>/.kl/rondas/<id>.tsv` (ronda, commit, puntaje,
   estado, checks que fallan, cambio) y `<repo>/.kl/reportes/<id>.md` con errores y
   arreglos por ronda.
7. **auto-loop.** `feature mejorar` corre la skill `kl:auto-loop`: lee el registro, busca
   hábitos repetidos y hace un cambio a `program.md`, que guía al builder. Si toca otro
   archivo, se revierte; si no, se commitea solo `program.md`.

Estados de ronda: `base`, `conservado`, `deshecho`, `completa`, `fuera_de_alcance`,
`sin_cambios`, `fallo_agente`.

Cada archivo de `checks/<id>/` con extensión `.py`, `.sh`, `.js`, `.mjs` o `.ts` es un check
y pasa si sale con 0 (`.py` usa `uv run python` si el repo tiene `pyproject.toml`). Las
skills están en `plugin/skills/` y se cargan con `--plugin-dir` solo en cada `claude -p`.
Conviene agregar `.trabajo/` y `.kl/` al `.gitignore` del repo destino.

## Arquitectura

Hexagonal: el núcleo (`src/nucleo/`) solo conoce seis puertos de salida, definidos en
`src/nucleo/puertos.ts`. No importa `fs`, `child_process` ni ningún adaptador.

**Entrada.** El núcleo expone dos puertos de entrada: `Corridas` (`src/nucleo/corridas.ts`),
con los casos de uso `interna` y `externa`, y `Features` (`src/nucleo/features.ts`), con
`checks`, `aprobar` y `mejorar`. Ahí viven las reglas que no dependen de
quién llama: repo limpio (`RepoConCambios`), un worktree por corrida, avisos de progreso
y cancelación con `AbortSignal` (`CorridaCancelada`). El adaptador de entrada `Consola`
(`src/adaptadores/entrada/consola.ts`) traduce argumentos a esos casos de uso y su
resultado a texto y código de salida (0, 1 rechazo como repo sucio o feature inexistente,
2 uso inválido, 130 cancelada).
Otro adaptador de entrada (HTTP, un scheduler) usaría el mismo puerto.

**Salida.** Los seis puertos de abajo los implementan los adaptadores de salida:

| Puerto        | Adaptador                   | Llega al núcleo por                        |
|---------------|-----------------------------|--------------------------------------------|
| `Agente`      | `ClaudeCli`                 | fábrica                                    |
| `Checks`      | `SalidaRecortada(ChecksUv)` | fábrica                                    |
| `Evaluador`   | `ChecksPorArchivo`          | fábrica (flujo por feature)                |
| `Entrenador`  | `EntrenadorUv`              | fábrica                                    |
| `Repositorio` | `RepositorioGit`            | input (un worktree por corrida)            |
| `Bitacora`    | `BitacoraTsv`               | input (interno) y fábrica (historial externo) |

- `crearMaquinaInterna(puertos)` y `crearMaquinaExterna(puertos)` construyen las
  máquinas. `Repositorio` y `Bitacora` llegan en el input porque cambian con cada
  worktree y cada tanda.
- Los prompts de cada fase son dominio y viven en `src/nucleo/encargos.ts` como
  valores `Encargo` (fase, system prompt, prompt, cwd y herramientas); el adaptador
  solo sabe ejecutarlos.
- Los adaptadores siguen Elegant Objects: el constructor solo asigna, campos
  privados `readonly`, sin `null` ni `static`, y decoradores en lugar de flags
  (`SalidaRecortada`). El núcleo sigue el estilo funcional de XState.

Para cambiar una pieza de infraestructura (otro agente, otro runner de checks) se
escribe una clase nueva en `src/adaptadores/` que implemente el puerto y se cambia su
construcción en `src/cli.ts`. El núcleo no se toca.

Para comprobar que el núcleo sigue limpio:

```bash
! grep -rnE 'from "(node:(fs|child_process)|\.\./adaptadores)' src/nucleo
```

## Tests

| Archivo                     | Qué cubre                                                    |
|-----------------------------|--------------------------------------------------------------|
| `test/maquinas.test.ts`     | las dos máquinas con `Agente`, `Checks` y `Entrenador` falsos, sobre git real en un repo temporal: los cinco status, reintentos de build, bloque protegido y worktrees |
| `test/consola.test.ts`      | adaptador de entrada con `Corridas` falsas: flags, defaults, validación y códigos de salida |
| `test/adaptadores.test.ts`  | `ChecksUv` (necesita `uv`), `SalidaRecortada` y `BitacoraTsv` |

Ninguno llama a `claude` ni consume cuota.
