# Concepts Brief: multiagente "coreógrafo + lanzador" en karpathy-loop

**Mode:** BRAINSTORM
**FeatureConcept:** ejecución multiagente con coreografía por eventos ("checks escritos", "build listo", "checks fallidos", "experimento conservado") y un lanzador que arranca, limita (USD, tiempo, concurrencia) y detiene procesos `claude -p` y sus worktrees.
**Repo:** `/Users/muruna/karpathy-loop` (rama `loop-interno-claude-code`)

## Recomendación final (6 lentes)

**No construir coreografía en el primer corte.** Las seis lentes coinciden en que
"multiagente" debe significar **réplicas del loop interno en paralelo**, cada una con su
máquina XState intacta en su propio worktree, y en que el "lanzador" se arma con
**decoradores de los puertos** cableados en `src/cli.ts`, no como subsistema propio.
La coreografía real (agentes que reaccionan a sucesos ajenos) no tiene hoy un consumidor
concreto: queda para después, y cuando llegue, el transporte es el sistema de actores
de XState, no un bus nuevo.

Orden recomendado:

1. **Medir antes de construir** (zoom-out): línea base con `--replicas 1` y prueba de
   ruido de entrenamientos simultáneos.
2. **Prerrequisitos** que ya son defectos hoy: costo de llamadas fallidas, tope USD en
   `quedaPresupuesto`, `onError` en `corriendoInterno`, cancelación con `AbortSignal`.
3. **Corte mínimo:** `--replicas N` (1 por defecto = comportamiento actual).

## Estado de los reviewers

| Reviewer | Estado | Nota |
| --- | --- | --- |
| `comprehension` | completed | Vía synthesizer (vale el reintento). |
| `codebase-details` | completed | Vía synthesizer (vale el reintento). |
| `design` | completed | Relanzado directo desde la sesión principal, sin leer este brief. |
| `zoom-out` | completed | Relanzado directo desde la sesión principal, sin leer este brief. |
| `structural` | completed | Relanzado directo desde la sesión principal, sin leer este brief. |
| `implementation-readiness` | completed | Relanzado directo desde la sesión principal, sin leer este brief. |

> Las cuatro lentes relanzadas no vieron la versión anterior de este brief: sus
> coincidencias con las dos primeras son lecturas independientes.

## Consenso de las seis lentes

1. **"Multiagente" = N loops internos en paralelo, uno por worktree, sobre la misma `base`.**
   Roles por fase no dan paralelismo: las fases dependen entre sí y la iteración N+1
   parte del `keep` de la N (design, zoom-out). Los roles ya existen como `Encargo`
   (`src/nucleo/encargos.ts:12,27,43`).
2. **XState sigue siendo el núcleo de garantías.** `aislandoChecks` y `verificando`
   (`src/nucleo/interno.ts:159,183`) necesitan un dueño único; reemplazar XState por
   coreografía es Blocker (design). La selección del externo (`superaMejor`) es
   orquestación por naturaleza y conviene llamarla así.
3. **Sin bus de eventos propio.** El sistema de actores de XState ya es un bus
   (design, structural, zoom-out). Los sucesos, si se agregan, son tipos de dominio.
4. **El lanzador son decoradores** sobre `Agente` y `Entrenador`, en el estilo de
   `SalidaRecortada` (`src/adaptadores/salida-recortada.ts:4`), compuestos en `src/cli.ts`.
5. **El entrenamiento se serializa** (las seis lentes): `TIEMPO_SEGUNDOS = 20` es de
   reloj (`prepare.py:4`).
6. **El único cambio de puerto justificado es `AbortSignal` en `Agente`** (design,
   structural, implementation-readiness). Es un estándar web, no rompe la pureza.

## Dónde las lentes difieren

| Tema | Postura A | Postura B | Resolución |
| --- | --- | --- | --- |
| Paralelismo hoy | zoom-out: ya se pueden lanzar varios `cli.ts interno` en procesos separados | B4: un agente puede tocar worktrees hermanos bajo `.trabajo/` | Corren, pero rompen B1 y chocan en locks de `.git`. B4 depende de si `claude -p` en `dontAsk` puede editar fuera de su cwd: **verificar** con una prueba antes de mover worktrees. |
| Eventos con `emit` | comprehension y codebase-details: emitir los 4 hitos para observabilidad | zoom-out y design: especulativo sin consumidor | Primer corte: prefijo por réplica en el log de `cli.ts`. `emit` cuando haya un consumidor. |
| Coordinación | design: supervisor XState con `spawnChild` | comprehension, zoom-out: `Promise.allSettled` en `cli.ts` | `Promise.allSettled` en el composition root. Supervisor XState solo si se suma el externo paralelo. |
| Comando | design: subcomando `paralelo` | resto: flag `--replicas` | `--replicas N` en `interno`, 1 por defecto: volver atrás es no pasarlo (implementation-readiness). |

---

## Respuestas a las 5 preguntas

### 1. Qué significa "multiagente"
- **Recomendación:** réplicas del loop interno, cada una en su worktree (`<prefijo>-r<k>`), todas desde la misma `base` y el mismo `program.md`.
- **Opciones descartadas para el corte mínimo:**
  - roles por fase en el mismo worktree: no ganan nada y rompen `fuera_de_alcance`;
  - tandas externas en paralelo: chocan con el Blocker B2.
- **Terminología.** Comprehension pide fijar los términos:
  - "réplica" para el loop interno paralelo;
  - "rol" para las fases;
  - "tanda paralela" para el loop externo concurrente.

### 2. Coreografía y XState
- **Estado actual:** no hay `on:`, `emit`, `raise` ni `sendTo` en `src/`. Las máquinas solo usan `invoke` y `always`. XState 5.33.4 ya trae `emit` (fuente: codebase-details).
- **Dónde se emite cada evento** (líneas según codebase-details):

  | Evento | Punto de emisión |
  | --- | --- |
  | checks escritos | `escribiendoChecks.onDone` (`src/nucleo/interno.ts:147`) |
  | build listo | `verificando` → `corriendoChecks` (`src/nucleo/interno.ts:185`) |
  | checks fallidos | `checksFallidos.entry` (`src/nucleo/interno.ts:211`) |
  | experimento conservado | `conservando.entry` (`src/nucleo/interno.ts:235`) |

  Comprehension cita líneas parecidas pero no iguales (`:176`, `:200-205`, `:234`). Hay que confirmarlas al implementar.
- **Consumo:** con `actor.on(...)` en `src/cli.ts:36-49`.
- **Para que los agentes reaccionen entre sí** habría que agregar `on:` y partir la máquina interna en actores. Eso queda fuera del corte mínimo.
- **Choque de nombres:** "evento" se cruza con el `event` de XState. Hay que declarar que son eventos XState emitidos con `emit` o ponerles otro nombre ("hito").

### 3. Lugar en la hexagonal
- **En `src/nucleo/puertos.ts`:** tipos de evento como valores puros y un puerto `Eventos { publicar(e) }`, sin `node:events`.
- **En `src/adaptadores/`:** decoradores del lanzador.
  - `AgenteLimitado(origen, semáforo)`: limita la concurrencia de `claude -p`.
  - `AgenteConTope(origen, libroCostos)`: aplica el tope USD global con reserva.
  - `EntrenadorSerializado(origen)`: semáforo de 1.
- **Requisito sobre el puerto:** la cancelación obliga a modificar `Agente.respuesta(encargo)` para que acepte un `AbortSignal` (ver Major M2).
- **README:** si se agrega un puerto nuevo, hay que actualizar la tabla de puertos.

### 4. Garantías en riesgo
Ver la sección de hallazgos priorizados (B1 a B5, M1 a M9).

### 5. Corte mínimo viable (consolidado)

**Paso 0, sin código** (zoom-out):
- Línea base: `--replicas 1` con los defaults, 3 corridas.
- Ruido: entrenar `train.py` sin cambios con K = 2 y 4 simultáneos y medir cuánto se
  mueve `val_loss`. Si supera la ganancia típica de un `keep`, serializar es obligatorio.

**Prerrequisitos** (defectos de hoy, útiles aunque no se paralelice):
- `ClaudeCli` conserva `total_cost_usd` también en errores y salidas con código ≠ 0
  (`src/adaptadores/claude-cli.ts:38-40`).
- `quedaPresupuesto` mira `costoUsd` contra un tope por corrida
  (`src/nucleo/interno.ts:94-95`); un fallo de agente deja fila en la bitácora en lugar
  de girar en vacío (`src/nucleo/interno.ts:155,180`).
- `corriendoInterno` con `onError` que quite el worktree (`src/nucleo/externo.ts:93-113`).
- `Agente.respuesta(encargo, signal)` y procesos en grupo propio (`detached` +
  `process.kill(-pid)`) en `ClaudeCli` y `EntrenadorUv`.

**Corte:**
- `node src/cli.ts interno --replicas N --tope-usd X`, etiquetas `<etiqueta>-r<k>`,
  worktrees creados uno tras otro, un `results.tsv` por réplica.
- N máquinas `crearMaquinaInterna` con `Promise.allSettled` y limpieza en `finally` y
  ante SIGINT.
- Decoradores: `LibroDeGasto(ClaudeCli)` (tope USD compartido), `Semaforo(…, n)`
  (concurrencia de agentes), `EntrenamientoExclusivo(EntrenadorUv)`.
- Prefijo por réplica en el log y tabla resumen al final.

**Métrica:** ganancia (`lineaBase − mejor`) por USD y por minuto de reloj, 3 corridas
por K ∈ {1, 2, 4}. Seguir solo si K > 1 mejora la ganancia por minuto sin empeorar la
ganancia por USD más allá de un umbral fijado antes.

**Queda para después:** coreografía y bus, `emit` de hitos, supervisor XState, loop
externo paralelo, roles por fase, combinar ramas ganadoras.

---

## Hallazgos priorizados (Blocker → Major → Nit)

### B1. La comparación justa se rompe con entrenamientos simultáneos (Severity: Blocker)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `train.py:19`, `prepare.py:4`, `README.md:14`, `README.md:103`, `program.md:36-37`, `src/nucleo/interno.ts:120-128`, `src/nucleo/externo.ts:47`
* **Problema:**
  - el presupuesto de entrenamiento es de reloj, 20 s;
  - con N entrenamientos a la vez cada uno da menos pasos y saca peor `val_loss`;
  - que cada réplica mida su propia línea base no lo compensa, porque la contención cambia en el tiempo;
  - la `ganancia` entre versiones de `program.md` deja de ser válida.
* **Recomendación:** `EntrenadorSerializado`/`EntrenadorExclusivo` con concurrencia 1. Documentarlo en el README.

### B2. El working tree raíz y `program.md` son compartidos (Severity: Blocker si se paraleliza el loop externo)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `src/nucleo/encargos.ts:48`, `src/nucleo/externo.ts:99`, `src/nucleo/externo.ts:121-123`, `src/nucleo/externo.ts:157`
* **Problema:**
  - el meta-agente edita `program.md` en la raíz;
  - cada tanda lo lee desde ahí;
  - `custodiando` hace `restaurar(".")` y `conservando` commitea en la rama actual;
  - las tandas concurrentes se pisan;
  - el hill-climbing en paralelo no define de qué versión parte cada propuesta.
* **Recomendación:** dejarlo fuera del corte mínimo. Si se aborda después, cada candidato de `program.md` necesita su propio worktree y hay que definir la semántica del hill-climbing en paralelo.

### B3. Un worktree por réplica, sin excepciones (Severity: Blocker)
* **Lente:** `comprehension` (`codebase-details` coincide)
* **Alcance:** `src/adaptadores/repositorio-git.ts:18-30`, `src/nucleo/interno.ts:83-91`
* **Problema:**
  - `tocados()` y `tocadosFueraDelIndex()` miran todo el worktree;
  - dos agentes en el mismo worktree generan `fuera_de_alcance` falsos;
  - `descartar()` (`reset --hard` + `clean -fdq`) borra el trabajo del otro.
* **Recomendación:** que el lanzador garantice un worktree exclusivo por réplica.

### B4. El alcance se fuga hacia worktrees hermanos (Severity: Blocker con concurrencia)
* **Lente:** `codebase-details`
* **Alcance:** `src/adaptadores/repositorio-git.ts:67`, `.gitignore:8`, `src/nucleo/externo.ts:110`
* **Problema:**
  - los worktrees viven en `.trabajo/`, dentro de la raíz;
  - el meta-agente corre con cwd en la raíz y con `Edit`, así que puede editar `.trabajo/*/train.py`;
  - `tocados()` ignora `.trabajo/` y el guard no lo detecta;
  - hoy no pasa porque el worktree se quita antes de proponer, pero con concurrencia sí pasa.
* **Recomendación:** crear los worktrees fuera de la raíz del repo.

### B5. Coreografiar procesos de agente contradice el contrato del README (Severity: Blocker conceptual)
* **Lente:** `comprehension`
* **Alcance:** `README.md:3-5`, `README.md:93-106`
* **Problema:** si los agentes `claude -p` reaccionan a eventos, la secuencia de fases deja de estar en la máquina. Eso invalida "el ciclo lo corre la máquina" y la sección "Lo que la máquina garantiza".
* **Recomendación:** la coreografía va entre actores XState, nunca entre procesos de agente.

### M1. El costo queda subcontado y no hay tope global (Severity: Major)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `src/adaptadores/claude-cli.ts:35`, `src/adaptadores/claude-cli.ts:40`, `src/nucleo/interno.ts:51`, `src/nucleo/interno.ts:151`, `src/nucleo/interno.ts:155`, `src/nucleo/interno.ts:178-181`, `src/nucleo/externo.ts:147`, `src/cli.ts:55`
* **Problema:**
  - cuando el subtype no es `success` (por ejemplo, tope de presupuesto), el error descarta `total_cost_usd`;
  - un timeout tampoco devuelve costo;
  - los `onError` no suman nada;
  - el único tope es por invocación: hasta 4 por iteración (`INTENTOS_BUILD`) y además × N réplicas;
  - un tope aplicado después de la llamada permite sobregirar hasta N × `KL_PRESUPUESTO_AGENTE_USD`.
* **Recomendación:** que `ClaudeCli` reporte el costo también cuando falla. Un libro de costos compartido que reserve antes de lanzar. Nueva variable `KL_PRESUPUESTO_TOTAL_USD`.

### M2. No hay cancelación (Severity: Major)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `src/nucleo/puertos.ts:29-31`, `src/nucleo/interno.ts:77-79`, `src/adaptadores/claude-cli.ts:35`
* **Problema:**
  - `respuesta(encargo)` no recibe `AbortSignal`;
  - `fromPromise` recibe `signal` pero lo ignora;
  - detener una máquina no mata `claude -p`.
* **Recomendación:** extender el puerto con `AbortSignal` y propagarlo hasta `execFile`.

### M3. Quedan worktrees y ramas huérfanos (Severity: Major)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `src/adaptadores/repositorio-git.ts:66-70`, `src/nucleo/externo.ts:103-112`, `src/cli.ts:62`
* **Problema:**
  - el modo `interno` nunca quita su worktree;
  - `externo` lo quita solo en `onDone` y `corriendoInterno` no tiene `onError`;
  - con Ctrl-C quedan restos;
  - no hay `prune` ni inventario.
* **Recomendación:** `quitar` en un `finally` y ante SIGINT, más un inventario o `prune` al arrancar.

### M4. Las etiquetas de rama chocan (Severity: Major)
* **Lente:** `codebase-details` (comprehension lo menciona al reusar `--etiqueta`)
* **Alcance:** `src/cli.ts:27`, `src/adaptadores/repositorio-git.ts:68`, `src/nucleo/externo.ts:89`
* **Problema:**
  - la etiqueta por defecto tiene resolución de minuto;
  - `worktree add -b` falla si la rama existe;
  - `${prefijo}-v${version}` supone una sola tanda por versión.
* **Recomendación:** etiquetas `<prefijo>-r<k>` únicas por réplica.

### M5. Los procesos no se matan por completo (Severity: Major)
* **Lente:** `codebase-details`
* **Alcance:** `src/adaptadores/entrenador-uv.ts:21`
* **Problema:** el timeout manda SIGKILL solo a `uv` y puede dejar `python` vivo.
* **Recomendación:** grupos de procesos (`detached` + kill del grupo) en el lanzador.

### M6. La bitácora es concurrente y las filas no identifican a la réplica (Severity: Major)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `src/adaptadores/bitacora-tsv.ts:16-19`, `src/nucleo/interno.ts:46`, `src/nucleo/interno.ts:100`, `src/nucleo/interno.ts:212`, `program.md:51`, `meta-prompt.md:9`
* **Problema:**
  - `existsSync` → `writeFileSync` es TOCTOU entre procesos;
  - las filas no identifican a la réplica;
  - `fuera_de_alcance` y `checks_fallidos` anotan el commit `"-"`;
  - no hay columnas de costo ni de duración.
* **Recomendación:**
  - una bitácora por worktree y un único escritor para `historial.tsv`;
  - si se agrega una columna, actualizar `program.md:51` (fuera del bloque protegido) y `meta-prompt.md:9`.

### M7. `--minutos` es un tope blando y el tiempo en cola se descuenta (Severity: Major)
* **Lente:** `comprehension` (Nit/Major), `codebase-details`
* **Alcance:** `src/nucleo/interno.ts:94-95`, `src/cli.ts:56`
* **Problema:**
  - solo se evalúa en `siguiente`;
  - una llamada de 15 min puede pasarse del tope;
  - la espera en el semáforo consume el reloj del loop.
* **Recomendación:** definir si el límite del lanzador corta procesos en vuelo o solo impide lanzar nuevos, y si `--minutos` es por réplica o global.

### M8. Falta observabilidad y correlación (Severity: Major)
* **Lente:** `comprehension`, `codebase-details`
* **Alcance:** `src/cli.ts:39-43`
* **Problema:**
  - solo se imprime el `s.value` del actor raíz, así que bajo `externo` no se ve el interno;
  - con N réplicas la salida se mezcla;
  - un sistema coreografiado no tiene un "estado actual" único.
* **Recomendación:**
  - cada evento lleva `{etiqueta, version, iteracion, intento, fase, pid, costoUsd, subtype, ms}`;
  - prefijo `[etiqueta/réplica]` en cada línea;
  - log `.trabajo/<etiqueta>/eventos.jsonl`, o la ruta equivalente fuera de la raíz;
  - un comando `status` o `inspect` y un resumen final.

### M9. "Multiagente" es ambiguo y faltan flags (Severity: Major)
* **Lente:** `comprehension`
* **Alcance:** `README.md:39-49`
* **Problema:** el concepto admite tres lecturas, y no se distinguen los topes por llamada de los globales.
* **Recomendación:** elegir y nombrar la lectura (ver la pregunta 1). Documentar `--replicas`, `--concurrencia`, `KL_PRESUPUESTO_TOTAL_USD` y la semántica de `--minutos`.

### N1. "Tanda" no está definida (Severity: Nit)
* **Lente:** `comprehension`
* **Alcance:** `README.md:9-10`
* **Recomendación:** definirla antes de que se confunda con "lote de réplicas".

### N2. "Evento" choca con el `event` de XState (Severity: Nit)
* **Lente:** `comprehension`
* **Recomendación:** declarar que se emiten con `emit` o usar "hito".

### N3. Convención de flags (Severity: Nit)
* **Lente:** `comprehension`
* **Recomendación:** mantener sustantivos en plural en español.

### N4. `execFileSync` en `RepositorioGit` (Severity: Nit)
* **Lente:** `codebase-details`
* **Alcance:** `src/adaptadores/repositorio-git.ts:81`
* **Problema:** bloquea el event loop. Como efecto lateral favorable, serializa los `git worktree add` dentro del proceso.

### N5. Timeouts de 60 s bajo carga (Severity: Nit)
* **Lente:** `codebase-details`
* **Alcance:** `src/cli.ts:58-59`
* **Problema:** pueden producir un `crash` falso cuando hay concurrencia.

### N6. `run.log` es legible para el investigador (Severity: Nit, preexistente)
* **Lente:** `codebase-details`
* **Alcance:** `src/adaptadores/entrenador-uv.ts:16`, `program.md:21`
* **Problema:** contradice lo que declara `program.md`. Ya ocurre hoy, sin concurrencia.

---

## Hallazgos de las lentes relanzadas

Cambios de severidad respecto a las dos primeras lentes:

- **M1 (costo subcontado) pasa a Blocker** para el corte: sin él, el tope USD global
  cuenta de menos (implementation-readiness, design).
- **M2 (sin cancelación) pasa a Blocker:** sin `AbortSignal` el lanzador no puede
  detener; XState detiene el actor pero `claude -p` sigue gastando (structural,
  implementation-readiness).

Hallazgos nuevos:

### B6. El loop gira en vacío al agotar el presupuesto (Severity: Blocker)
* **Reviewer Lens:** `design`, `structural`, `zoom-out`
* **Affected Scope:** `src/nucleo/interno.ts:94-95,155,180`
* **Problema:** `quedaPresupuesto` ignora `costoUsd`. Si un decorador de tope lanza
  error, `onError → siguiente` consume iteraciones sin dejar fila.
* **Requisito:** guarda de costo en `quedaPresupuesto` y fila en la bitácora cuando
  falla el agente.

### M10. `corriendoInterno` no tiene `onError` (Severity: Major)
* **Reviewer Lens:** `implementation-readiness`, `design`
* **Affected Scope:** `src/nucleo/externo.ts:93-113`
* **Problema:** un error del interno deja el worktree colgado y la máquina externa sin
  transición. Verificado en el código.
* **Nota:** en el modo `interno` el worktree se conserva a propósito: guarda
  `results.tsv` y la rama con los `keep` (`src/cli.ts:62-65`). Para réplicas, decidir
  si se conserva o se archiva.

### M11. Cambiar el esquema de `results.tsv` desalinea archivos existentes (Severity: Major)
* **Reviewer Lens:** `implementation-readiness`
* **Affected Scope:** `src/nucleo/interno.ts:46`, `src/adaptadores/bitacora-tsv.ts:16`
* **Problema:** `BitacoraTsv` no reescribe el encabezado de un archivo existente.
* **Requisito:** no agregar columnas en el corte; la réplica se identifica por el
  archivo, no por una columna.

### M12. Git concurrente compite por locks (Severity: Major)
* **Reviewer Lens:** `implementation-readiness`, `design`, `structural`
* **Affected Scope:** `src/adaptadores/repositorio-git.ts:66-69,81`
* **Problema:** `worktree add` y commits concurrentes chocan en `index.lock` y
  `worktrees/`; `-b autoresearch/<etiqueta>` falla si la rama existe. Amplía N4.
* **Requisito:** crear worktrees en serie, etiquetas únicas y un comando de limpieza
  idempotente.

### N7. Reloj implícito (Severity: Nit)
* **Reviewer Lens:** `structural`
* **Affected Scope:** `src/nucleo/interno.ts:95,108`
* **Problema:** `Date.now()` en el núcleo. Un puerto `Reloj` solo hace falta cuando los
  tests de tiempo lo exijan.

### N8. `Encargo` sin identidad y `Fase` cerrada (Severity: Nit)
* **Reviewer Lens:** `structural`, `implementation-readiness`
* **Affected Scope:** `src/nucleo/puertos.ts:4,7-13`
* **Problema:** dos agentes en la misma fase no se distinguen. Irrelevante con réplicas
  (cada una tiene su máquina); necesario con roles.

### N9. Binario `claude` fijo y grep de pureza corto (Severity: Nit)
* **Reviewer Lens:** `structural`
* **Affected Scope:** `src/adaptadores/claude-cli.ts:22`, `README.md:138`
* **Problema:** recibir el binario por constructor permite probar la cancelación con un
  script falso sin cuota. El grep no detecta `process` ni `setTimeout` en el núcleo.

## Criterios de done del corte (implementation-readiness)

- `npm test`, `npm run typecheck` y el grep de pureza en verde.
- **Abort:** agente falso que nunca resuelve; la máquina termina, deja status y
  `git worktree list` queda en 1 línea.
- **Costo en fallos:** `claude` falso en PATH que devuelve
  `{"subtype":"error_max_budget_usd","total_cost_usd":1.5}` con código 1; el costo
  acumulado es 1.5.
- **Concurrencia:** agente falso que cuenta llamadas simultáneas; nunca supera N y al
  llegar al tope USD no arranca nuevas.
- **Huérfanos:** script que lanza un nieto con `sleep`; tras el abort, `ps -p` no lo
  encuentra.

## Lo reutilizable sin cambios (codebase-details)
- `ChecksUv` y `SalidaRecortada` ya reciben `dir` como parámetro.
- `BitacoraTsv` sirve con una instancia por worktree.
- `RepositorioGit` ya tiene `worktree` y `quitar`.
- `encargos.ts` toma el cwd del worktree.
- Las fábricas `crearMaquinaInterna(puertos)` permiten componer decoradores.
- `test/maquinas.test.ts`, con agentes falsos, sirve de base para probar la concurrencia sin gastar cuota.

## Decisiones abiertas antes de implementar
1. Confirmar "réplicas del loop interno" como alcance y dejar la coreografía para después.
2. Tope USD: global por corrida o por réplica; al llegar, ¿se cortan procesos en vuelo o
   solo no se lanzan nuevos? ¿Qué status queda (`cancelado`)?
3. Semántica de `--minutos`: por réplica o global.
4. Si el paso 0 muestra ruido bajo, ¿se acepta entrenar en paralelo o se serializa igual?
5. Destino de los worktrees de réplicas perdedoras: conservar, archivar o quitar.
6. Si B4 se confirma (el agente puede editar fuera de su cwd), dónde ubicar los
   worktrees fuera de la raíz.
