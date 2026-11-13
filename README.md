# karpathy-loop

Los dos loops de autoresearch como máquinas XState v5. A diferencia del repo de
Karpathy, aquí el ciclo lo corre la máquina y el agente (Claude Code en modo `claude -p`)
solo escribe checks y cambios. Cada iteración interna: write checks → build → pass checks
→ entrenar.

| Archivo            | Rol                                                            |
|--------------------|----------------------------------------------------------------|
| `prepare.py`       | fijo: datos, presupuesto de 20 s y `evaluar` (`val_loss`)      |
| `train.py`         | lo que cambia el investigador en la fase build                 |
| `checks/`          | checks que escribe el investigador; los corre la máquina       |
| `program.md`       | system prompt del investigador; lo reescribe el loop externo   |
| `meta-prompt.md`   | system prompt del meta-agente del loop externo                 |
| `src/nucleo/`      | máquinas XState, puertos y encargos; sin infraestructura       |
| `src/adaptadores/` | implementaciones de los puertos (git, TSV, uv, `claude -p`)    |
| `src/cli.ts`       | composition root: construye los adaptadores y los cablea       |

## Arquitectura

Hexagonal: el núcleo (`src/nucleo/`) solo conoce cinco puertos, definidos en
`src/nucleo/puertos.ts`. No importa `fs`, `child_process` ni ningún adaptador.

| Puerto        | Adaptador                                | Llega por          |
|---------------|------------------------------------------|--------------------|
| `Agente`      | `ClaudeCli`                              | fábrica            |
| `Checks`      | `SalidaRecortada(ChecksUv)`              | fábrica            |
| `Entrenador`  | `EntrenadorUv`                           | fábrica            |
| `Repositorio` | `RepositorioGit`                         | input (worktree)   |
| `Bitacora`    | `BitacoraTsv`                            | input / fábrica    |

- `crearMaquinaInterna(puertos)` y `crearMaquinaExterna(puertos)` construyen las
  máquinas. `Repositorio` y `Bitacora` llegan en el input porque cambian con cada
  worktree y cada tanda.
- Los prompts de cada fase son dominio y viven en `src/nucleo/encargos.ts` como
  valores `Encargo`; el adaptador solo sabe ejecutarlos.
- Los adaptadores siguen Elegant Objects: el constructor solo asigna, campos
  privados `readonly`, sin `null` ni `static`, y decoradores en lugar de flags
  (`SalidaRecortada`). El núcleo sigue el estilo funcional de XState.

## Uso

```bash
npm install
npm test                                   # núcleo con fakes y adaptadores locales, sin cuota
node src/cli.ts interno --iteraciones 10   # un loop interno real
node src/cli.ts externo --versiones 4 --iteraciones 8
```

Requiere el CLI `claude` autenticado y `uv`. Cada iteración real llama a Claude Code
al menos dos veces y consume cuota (`KL_MODELO`; `KL_PRESUPUESTO_AGENTE_USD` por
llamada). El repo tiene que estar sin cambios: las máquinas hacen `checkout` y `reset`.

Los experimentos corren en worktrees bajo `.trabajo/` (rama `autoresearch/<etiqueta>`).
El loop externo deja `meta/historial.tsv` y `meta/resultados-v<n>.tsv`.

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
