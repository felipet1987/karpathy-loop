# karpathy-loop

Loops de autoresearch como máquinas XState v5 que orquestan Claude Code (`claude -p`). A
diferencia del repo de Karpathy, el ciclo lo corre la máquina: el agente solo escribe
checks y cambios, y la máquina decide qué se conserva.

Hay dos modos:

- **Loop interno y loop externo** sobre el repo actual: el interno hace cambios
  verificados por checks; el externo mejora las instrucciones del interno (`program.md`).
- **Flujo por feature** sobre cualquier repo: una persona pide una feature, aprueba sus
  checks y la máquina construye hasta que pasan.

## Los loops en una mirada

Hay dos niveles de loop: uno que **hace cambios** y otro que **mejora las instrucciones**
del primero. Los dos modos los repiten con distinto origen del pedido:

| | Modo autoresearch | Modo feature |
|---|---|---|
| Quién decide qué construir | el agente, leyendo el historial | una persona, en `features.md` |
| Quién aprueba los checks | nadie: la máquina exige que solo toquen `checks/` | la persona, antes de construir |
| Loop que hace cambios | **loop interno**: iteraciones write checks → build → pass checks | **rondas**: el builder intenta hasta que pasan todos los checks |
| Qué se conserva | cada iteración cuyos checks pasan | cada ronda que sube el puntaje (checks que pasan) |
| Loop que mejora instrucciones | **loop externo**: prueba versiones de `program.md` corriendo tandas del interno | **auto-loop**: lee el registro de rondas y ajusta `program.md` |
| Cómo se juzga la mejora | la versión que conserva más iteraciones (`mejora` / `sin_mejora`) | no se mide: un cambio por llamada, revisable en git |

```
              ┌──────────── loop externo / auto-loop ────────────┐
              │  lee resultados → reescribe program.md            │
              └───────────────┬─────────────────▲────────────────┘
                     program.md (system prompt)  │ results.tsv / rondas
              ┌───────────────▼─────────────────┴────────────────┐
              │  loop interno / rondas                           │
              │  write checks → build → pass checks → conservar   │
              └───────────────────────────────────────────────────┘
```

En los dos niveles la máquina XState decide y el agente propone: el agente no puede hacer
commits, correr checks ni tocar fuera de su fase.

## Loop interno

El loop interno mejora el proyecto de a un cambio por iteración. Cada iteración tiene tres
fases, y las dos primeras son llamadas separadas a `claude -p` sin shell:

```
escribiendoChecks ─▶ aislandoChecks ─▶ construyendo ─▶ verificando ─▶ corriendoChecks
   (agente)            (máquina)          (agente)       (máquina)        (máquina)
                                             ▲                                 │
                                             └──── fallan (hasta 3 intentos) ──┤
                                                                               │ pasan
                                             siguiente ◀── conservando (commit) ◀┘
```

1. **Write checks.** El agente lee el historial (`results.tsv`), decide UN cambio y
   escribe en `checks/` lo que el cambio tiene que cumplir. Solo puede tocar `checks/`.
2. **Build.** Otro `claude -p` implementa el cambio. Los checks ya están en el index de
   git, así que la máquina detecta si los toca. Si en el intento anterior fallaron, recibe
   su salida.
3. **Pass checks.** La máquina corre cada `checks/*.py` con `uv run python`. Si pasan,
   commitea el cambio y sus checks: la iteración se **conserva**. Si fallan, vuelve a
   build; tras 3 intentos, la descarta.

No hay entrenamiento ni métrica numérica: un cambio vale si sus checks pasan, y los checks
de iteraciones anteriores siguen corriendo, así que un cambio nuevo no puede romper lo
conservado. El resultado de la corrida es **cuántas iteraciones se conservaron**.

El agente recibe `program.md` como system prompt: ahí está qué tipo de cambios buscar y
cómo escribir checks.

| Status en `results.tsv` | Significado                                                       |
|-------------------------|-------------------------------------------------------------------|
| `keep`                  | los checks pasaron; el commit queda en la rama                    |
| `fuera_de_alcance`      | en checks tocó algo fuera de `checks/`, o en build tocó `checks/` o no cambió nada; se deshizo |
| `checks_fallidos`       | tras 3 intentos de build los checks no pasaron; se deshizo        |
| `fallo_agente`          | la llamada a `claude -p` falló; su costo igual se cuenta, se deshizo |

La corrida termina al llegar a `--iteraciones`, a `--minutos` o a `--tope-usd`.

## Loop externo

El loop externo mejora `program.md`, las instrucciones del loop interno. Prueba versiones
y se queda con la que más rinde:

```
preparando ─▶ corriendoInterno ─▶ decidiendo ─▶ conservando  (mejora)     ─▶ siguiente
    ▲            (una tanda)          │                                        │
    │                                 └──────▶ descartando  (sin_mejora)  ─────┤
    │                                                                          ▼
    └──────── custodiando ◀──────── proponiendoPrograma (meta-agente) ◀── ¿quedan versiones?
```

1. **Tanda.** Corre un loop interno completo en su propio worktree con la versión actual
   de `program.md`. Todas las tandas parten del mismo commit, para comparar en igualdad.
2. **Decidir.** Si la tanda conservó más iteraciones que la mejor hasta ahora, el estado
   de la versión es `mejora` y se commitea `program.md`. Si no, `sin_mejora` y se
   restaura la versión anterior.
3. **Proponer.** Un meta-agente (`claude -p` con `meta-prompt.md`) lee el historial y los
   resultados de las tandas y hace UN cambio a `program.md`.
4. **Custodiar.** Si el meta-agente tocó otro archivo o el bloque
   `<!-- protegido -->` de `program.md`, la máquina revierte su cambio.

Repite hasta `--versiones`. El historial queda en `meta/historial.tsv` (versión,
iteraciones conservadas y estado de mejora) y cada tanda en `meta/resultados-v<n>.tsv`.

## Flujo por feature (checks primero)

Construye features pedidas por una persona en cualquier repo git (`--repo`, por defecto
el actual).

1. **Pedido.** Una sección `## <id>` en `features.md`, commiteada.
2. **write-checks.** `feature checks <id>` crea el worktree `.trabajo/feature-<id>` (rama
   `feature/<id>`) y la skill `kl:write-checks` escribe tests en `checks/<id>/` antes del
   código. Si toca algo fuera de esa carpeta, se descarta todo. Los checks quedan **sin
   commitear**.
3. **Revisar checks.** La persona los lee y los ajusta en el worktree. Decide ella.
4. **approve-checks.** `feature aprobar <id>` commitea `checks/<id>/` (rechaza cambios
   fuera de la carpeta). Desde ese commit la carpeta queda bloqueada.
5. **Rondas.** La skill `kl:feature-builder` (un `claude -p` nuevo por ronda) cambia el
   código; la máquina corre los checks y el puntaje es cuántos pasan. Si sube, se conserva
   (commit); si no, se deshace y la salida de los checks llega a la ronda siguiente. Tocar
   `checks/` descarta la ronda. Termina cuando todos pasan, se agotan las rondas o se
   llega al tope de USD. Repetir `aprobar` sigue con más rondas.
6. **Registro y reporte.** `<repo>/.kl/rondas/<id>.tsv` (ronda, commit, puntaje, estado,
   checks que fallan, cambio) y `<repo>/.kl/reportes/<id>.md` con errores y arreglos.
7. **auto-loop.** `feature mejorar` corre la skill `kl:auto-loop`: lee el registro, busca
   hábitos repetidos y hace un cambio a `program.md`. Si toca otro archivo, se revierte;
   si no, se commitea solo `program.md`.

Estados de ronda: `base`, `conservado`, `deshecho`, `completa`, `fuera_de_alcance`,
`sin_cambios`, `fallo_agente`.

Cada archivo de `checks/<id>/` con extensión `.py`, `.sh`, `.js`, `.mjs` o `.ts` es un check
y pasa si sale con 0 (`.py` usa `uv run python` si el repo tiene `pyproject.toml`). Las
skills se cargan con `--plugin-dir` solo en cada `claude -p` (detalle en
`plugin/README.md`). Conviene agregar `.trabajo/` y `.kl/` al `.gitignore` del repo destino.

## Requisitos

- Node ≥ 24: corre TypeScript sin compilar (`erasableSyntaxOnly`).
- `uv`, para correr los checks de Python.
- El CLI `claude`, autenticado. Solo hace falta para las corridas reales, no para `npm test`.

## Uso por consola

```bash
npm install
npm test                                     # sin cuota: agentes falsos
npm run typecheck
node src/main.ts interno --iteraciones 10    # sobre el repo de la carpeta actual
node src/main.ts externo --versiones 4 --iteraciones 8
node src/main.ts feature checks <id> --repo ../otro-repo
node src/main.ts feature aprobar <id> --repo ../otro-repo --rondas 5
node src/main.ts feature mejorar --repo ../otro-repo
```

| Flag            | `interno`        | `externo`        | `feature aprobar` | Qué controla                       |
|-----------------|------------------|------------------|-------------------|------------------------------------|
| `--iteraciones` | 10               | 8 por tanda      | —                 | iteraciones del loop interno       |
| `--minutos`     | 15               | 10 por tanda     | —                 | tope de reloj del loop interno     |
| `--versiones`   | —                | 4                | —                 | versiones de `program.md` a probar |
| `--rondas`      | —                | —                | 5                 | rondas del builder                 |
| `--tope-usd`    | sin tope         | sin tope, por tanda | sin tope       | gasto máximo; al alcanzarlo no empieza otra iteración |
| `--etiqueta`    | fecha `AAAAMMDDhhmm` (UTC) | ídem   | —                 | nombre del worktree y de la rama   |
| `--repo`        | —                | —                | `.`               | repo donde se construye la feature |

| Variable                    | Por defecto       | Qué controla                            |
|-----------------------------|-------------------|-----------------------------------------|
| `KL_MODELO`                 | `claude-opus-5-5` | modelo de cada llamada a `claude -p`    |
| `KL_PRESUPUESTO_AGENTE_USD` | `2`               | tope de gasto por llamada (`--max-budget-usd`) |

Códigos de salida: 0 bien, 1 rechazo (repo con cambios, feature inexistente), 2 uso
inválido, 130 cancelada con Ctrl-C.

`interno` y `externo` exigen el repo sin cambios, ni siquiera archivos nuevos sin
seguimiento: las máquinas hacen `checkout` y `reset`.

## Uso por REST

```bash
node src/main.ts servir --puerto 8787 --concurrencia 3   # escucha solo en 127.0.0.1
```

Las corridas duran minutos, así que cada POST crea un **trabajo** asíncrono y responde
`202` con su URL en `Location`. El cuerpo es JSON con las mismas opciones que los flags
(`topeUsd` en lugar de `--tope-usd`).

| Método y ruta                  | Cuerpo                                                 |
|--------------------------------|--------------------------------------------------------|
| `POST /corridas/interna`       | `{etiqueta?, iteraciones?, minutos?, topeUsd?}`        |
| `POST /corridas/externa`       | `{etiqueta?, versiones?, iteraciones?, minutos?, topeUsd?}` |
| `POST /features/{id}/checks`   | `{repo?}`                                              |
| `POST /features/{id}/aprobar`  | `{repo?, rondas?, topeUsd?}`                           |
| `POST /features/mejorar`       | `{repo?}`                                              |
| `GET /trabajos`                | lista de trabajos                                      |
| `GET /trabajos/{n}`            | estado, avisos de la máquina, salida o error           |
| `DELETE /trabajos/{n}`         | cancela: aborta la máquina y mata los procesos          |

**Features en paralelo.** Corren varios trabajos a la vez, hasta `--concurrencia` (3 por
defecto). Cada feature trabaja en su propio worktree, así que distintas features avanzan en
paralelo sin pisarse. Lo que comparte estado es exclusivo:

| Recurso                         | Trabajos que lo ocupan                         |
|---------------------------------|------------------------------------------------|
| `feature <repo> <id>`           | `checks` y `aprobar` de esa feature            |
| `mejorar <repo>`                | `mejorar` (escribe `program.md` en la raíz)    |
| `corridas`                      | `interna` y `externa` (exigen el repo limpio)  |

Estados de un trabajo: `corriendo`, `terminado`, `cancelado`, `rechazado`, `fallido`.
Respuestas de error: `400` pedido inválido, `409` el recurso ya está ocupado (indica qué
trabajo lo ocupa), `422` rechazo (repo con cambios, feature inexistente), `429` se alcanzó
`--concurrencia`, `404` y `405`. Cada trabajo tiene su propio `--tope-usd` (`topeUsd`); no
hay tope de gasto compartido entre trabajos.

```bash
curl -si -X POST localhost:8787/corridas/interna -d '{"iteraciones": 3, "topeUsd": 2}'
curl -s localhost:8787/trabajos/1
curl -s -X DELETE localhost:8787/trabajos/1
```

No hay autenticación: cualquier proceso local puede lanzar corridas que consumen cuota.

## Tutoriales

### 1. Primera feature por consola

Un repo de ejemplo con una feature: un script que saluda.

```bash
mkdir -p ~/demo-saludo && cd ~/demo-saludo && git init -q
cat > features.md <<'MD'
# Features

## saludo
Un script `hola.sh` en la raíz que, con un argumento NOMBRE, imprime `hola NOMBRE`;
sin argumento imprime `hola mundo`.
MD
printf '# Programa\n\n- Código en bash simple.\n' > program.md
printf '.trabajo/\n.kl/\n' > .gitignore
git add -A && git commit -qm base
```

Para probar barato, se usa Haiku y un tope por llamada:

```bash
export KL_MODELO=claude-haiku-5-5 KL_PRESUPUESTO_AGENTE_USD=0.3
cd /ruta/a/karpathy-loop
```

1. **Escribir los checks.** Crea el worktree y deja los checks sin commitear:

   ```bash
   node src/main.ts feature checks saludo --repo ~/demo-saludo
   ```

   La salida JSON trae `worktree` y la lista de `archivos` (por ejemplo,
   `checks/saludo/01-sin-argumento-imprime-hola-mundo.sh`).

2. **Revisarlos.** Se leen y, si hace falta, se editan en
   `~/demo-saludo/.trabajo/feature-saludo/checks/saludo/`. Cada uno sale con 0 si el
   comportamiento se cumple. Hoy fallan todos: `hola.sh` todavía no existe.

3. **Aprobar y construir.** Commitea los checks y corre las rondas:

   ```bash
   node src/main.ts feature aprobar saludo --repo ~/demo-saludo --rondas 3 --tope-usd 1
   ```

   Los avisos muestran `puntuandoBase → construyendo → corriendoChecks → …`. Termina con
   `"completa": true` y `"puntaje": "3/3"` cuando pasan todos.

4. **Leer el resultado.** El código quedó en la rama `feature/saludo`:

   ```bash
   git -C ~/demo-saludo/.trabajo/feature-saludo log --oneline
   cat ~/demo-saludo/.kl/reportes/saludo.md        # errores y arreglos por ronda
   cat ~/demo-saludo/.kl/rondas/saludo.tsv         # registro de rondas
   ```

5. **Mejorar las instrucciones.** Con varias features hechas, el auto-loop busca hábitos
   repetidos en el registro y ajusta `program.md`:

   ```bash
   node src/main.ts feature mejorar --repo ~/demo-saludo
   ```

   Responde `conservado` (commit de `program.md`), `revertido` (tocó otro archivo) o
   `sin_cambios` (no encontró nada que corregir).

Para integrar la feature: `git -C ~/demo-saludo merge feature/saludo`. Para descartarla:
`git -C ~/demo-saludo worktree remove .trabajo/feature-saludo` y borrar la rama.

### 2. Varias features en paralelo por REST

Con el repo del tutorial 1 y dos features más en `features.md` (`## despedida` y
`## ayuda`, commiteadas):

```bash
node src/main.ts servir --concurrencia 3 &

R='{"repo": "'$HOME'/demo-saludo"}'
curl -s -X POST localhost:8787/features/despedida/checks -d "$R"
curl -s -X POST localhost:8787/features/ayuda/checks -d "$R"
curl -s localhost:8787/trabajos | jq '.[] | {id, ruta, estado}'
```

Las dos corren a la vez, cada una en su worktree. Cuando terminan, se revisan los checks
como en el paso 2 del tutorial 1 y se aprueban también en paralelo:

```bash
curl -s -X POST localhost:8787/features/despedida/aprobar -d '{"repo": "'$HOME'/demo-saludo", "rondas": 3, "topeUsd": 1}'
curl -s -X POST localhost:8787/features/ayuda/aprobar -d '{"repo": "'$HOME'/demo-saludo", "rondas": 3, "topeUsd": 1}'
curl -s localhost:8787/trabajos/3 | jq '{estado, avisos: [.avisos[].estado], salida}'
```

Pedir `checks` de `despedida` mientras corre su `aprobar` responde `409` con el trabajo
que la ocupa. Un trabajo se cancela con `curl -X DELETE localhost:8787/trabajos/3`, que
mata sus procesos `claude -p` y checks. Ctrl-C en el servidor cancela todos.

### 3. Loop interno y externo sobre un repo propio

`interno` y `externo` trabajan sobre el repo git de la carpeta desde donde se corren y
leen `program.md` de su raíz (`externo` también `meta-prompt.md`). Se pueden copiar los de
este repo como punto de partida y adaptar su objetivo:

```bash
cd ~/mi-proyecto                       # repo git sin cambios pendientes
cp /ruta/a/karpathy-loop/{program.md,meta-prompt.md} .
printf '.trabajo/\nmeta/\nresults.tsv\n' >> .gitignore
git add -A && git commit -qm "instrucciones del loop"

export KL_MODELO=claude-haiku-5-5 KL_PRESUPUESTO_AGENTE_USD=0.3
node /ruta/a/karpathy-loop/src/main.ts interno --iteraciones 3 --tope-usd 1 --etiqueta prueba
```

El resultado trae `conservados`, `iteraciones` y `costoUsd`. Las iteraciones conservadas
están en la rama `autoresearch/prueba` y el detalle, en `.trabajo/prueba/results.tsv`.

Para que el loop externo pruebe versiones de `program.md`:

```bash
node /ruta/a/karpathy-loop/src/main.ts externo --versiones 3 --iteraciones 3 --tope-usd 1
cat meta/historial.tsv                 # versión, conservados, mejora | sin_mejora
git log --oneline -- program.md        # versiones con mejora commiteadas
```

Cada tanda corre un loop interno completo, así que el costo máximo es aproximadamente
`versiones × tope-usd`, más las llamadas del meta-agente.

## Qué deja cada corrida

- `interno`: worktree `.trabajo/<etiqueta>` en la rama `autoresearch/<etiqueta>`, con los
  commits conservados y `results.tsv`.
- `externo`: una etiqueta `<etiqueta>-v<n>` por tanda; anota en `meta/resultados-v<n>.tsv`
  y `meta/historial.tsv`. Quita el worktree al terminar cada tanda (las ramas quedan) y
  commitea en la rama actual las versiones de `program.md` con mejora.
- `feature`: worktree `.trabajo/feature-<id>` en la rama `feature/<id>`, registro y
  reporte en `<repo>/.kl/`.

## Lo que la máquina garantiza y un prompt no

- El agente no tiene shell: no puede correr checks ni hacer commits.
- Cada fase solo puede tocar lo suyo (checks: `checks/`; build: todo menos `checks/`;
  meta-agente y auto-loop: `program.md`). Si se sale, la máquina deshace su trabajo.
- Los checks los corre la máquina; sin pasarlos no hay commit.
- `claude -p` y cada check corren en su propio grupo de procesos. Un plazo vencido, un
  abort, Ctrl-C o `DELETE /trabajos/{n}` matan el grupo entero, con hijos y nietos.
- `claude -p` corre con `--setting-sources ""` y `--permission-mode dontAsk`: sin hooks
  ni `CLAUDE.md` del usuario, y solo con las herramientas de su fase.

Límites: 15 min por llamada al agente, 60 s por check del loop interno y 5 min por check
de feature, y vuelven al agente los últimos 4000 caracteres de la salida de los checks (2000 por
check en el flujo por feature).

## Arquitectura

Hexagonal. El núcleo (`src/nucleo/`) no importa `fs`, `child_process` ni ningún adaptador.

| Pieza                        | Archivo                                   |
|------------------------------|-------------------------------------------|
| Máquinas XState              | `src/nucleo/interno.ts`, `externo.ts`, `feature.ts` |
| Puertos de entrada           | `src/nucleo/corridas.ts` (`Corridas`), `src/nucleo/features.ts` (`Features`) |
| Puertos de salida            | `src/nucleo/puertos.ts`                   |
| Prompts de cada fase         | `src/nucleo/encargos.ts` (valores `Encargo`) |
| Adaptadores de entrada       | `src/adaptadores/entrada/consola.ts`, `rest.ts`, y `validacion.ts` compartida |
| Adaptadores de salida        | `src/adaptadores/*.ts`                    |
| Composition root             | `src/composicion.ts`                      |
| Punto de entrada             | `src/main.ts`: `servir` levanta el REST; cualquier otro comando va a la consola |

**Entrada.** Los puertos de entrada guardan las reglas que no dependen de quién llama:
repo limpio (`RepoConCambios`), un worktree por corrida, avisos de progreso y cancelación
con `AbortSignal` (`CorridaCancelada`). `Consola` y `Rest` solo traducen su protocolo a
esos casos de uso y validan con las mismas funciones, así que un pedido da las mismas
opciones venga de donde venga.

**Salida.**

| Puerto        | Adaptador                   | Llega al núcleo por                        |
|---------------|-----------------------------|--------------------------------------------|
| `Agente`      | `ClaudeCli`                 | fábrica                                    |
| `Checks`      | `SalidaRecortada(ChecksUv)` | fábrica (loop interno)                     |
| `Evaluador`   | `ChecksPorArchivo`          | fábrica (flujo por feature)                |
| `Repositorio` | `RepositorioGit`            | input (un worktree por corrida)            |
| `Bitacora`    | `BitacoraTsv`               | input (interno) y fábrica (historial externo) |

Los adaptadores siguen Elegant Objects: el constructor solo asigna, campos privados
`readonly`, sin `null` ni `static`, y decoradores en lugar de flags (`SalidaRecortada`).
Para cambiar una pieza de infraestructura se escribe una clase nueva que implemente el
puerto y se cambia su construcción en `src/composicion.ts`. El núcleo no se toca.

```bash
! grep -rnE 'from "(node:(fs|child_process)|\.\./adaptadores)' src/nucleo   # núcleo limpio
```

## Tests

| Archivo                     | Qué cubre                                                    |
|-----------------------------|--------------------------------------------------------------|
| `test/maquinas.test.ts`     | loops interno y externo con agentes y checks falsos sobre git real: status, reintentos, estado de mejora, bloque protegido, worktrees, cancelación |
| `test/features.test.ts`     | flujo por feature con checks `.sh` reales: rondas, rechazos, tope de USD, auto-loop y dos features en paralelo sobre el mismo repo |
| `test/consola.test.ts`      | adaptador de consola: flags, defaults, validación y códigos de salida |
| `test/rest.test.ts`         | adaptador REST sobre un servidor real: trabajos en paralelo, recursos exclusivos (409), concurrencia (429), 400/422/404/405 y cancelación |
| `test/adaptadores.test.ts`  | `ChecksUv` (necesita `uv`), `SalidaRecortada`, `BitacoraTsv` y `ClaudeCli` con un binario falso |

Ninguno llama a `claude` ni consume cuota.

## Licencia

MIT. Ver `LICENSE`.
