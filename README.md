# karpathy-loop

Los dos loops de autoresearch como máquinas XState v5. A diferencia del repo de
Karpathy, aquí el ciclo lo corre la máquina y el agente (Claude Code en modo `claude -p`) solo
escribe checks y cambios. Cada iteración interna: write checks → build → pass checks →
entrenar.

| Archivo            | Rol                                                            |
|--------------------|----------------------------------------------------------------|
| `prepare.py`       | fijo: datos, presupuesto de 20 s y `evaluar` (`val_loss`)      |
| `train.py`         | lo que cambia el investigador en la fase build                 |
| `checks/`          | checks que escribe el investigador; los corre la máquina       |
| `program.md`       | system prompt del investigador; lo reescribe el loop externo   |
| `meta-prompt.md`   | system prompt del meta-agente del loop externo                 |
| `src/interno.ts`   | máquina del loop interno                                       |
| `src/externo.ts`   | máquina del loop externo; invoca la interna como actor hijo    |
| `src/agentes.ts`   | actores reales: `uv run` (train y checks) y `claude -p`        |

## Uso

```bash
npm install
npm test                                   # máquinas con agentes falsos, sin cuota
node src/cli.ts interno --iteraciones 10   # un loop interno real
node src/cli.ts externo --versiones 4 --iteraciones 8
```

Requiere el CLI `claude` autenticado y `uv`. Cada iteración real llama a Claude Code
al menos dos veces y consume cuota (`KL_MODELO`, `KL_PRESUPUESTO_AGENTE_USD` por llamada). El repo tiene que estar sin
cambios: las máquinas hacen `checkout` y `reset`.

Los experimentos corren en worktrees bajo `.trabajo/` (rama `autoresearch/<etiqueta>`).
El loop externo deja `meta/historial.tsv` y `meta/resultados-v<n>.tsv`.

## Lo que la máquina garantiza y un prompt no

- El investigador no tiene shell: no puede entrenar, correr checks, hacer commits ni leer la evaluación.
- Al escribir checks solo puede tocar `checks/`; al construir, solo `train.py` (los checks
  quedan en el index, así se detecta si los debilita). Si no, `fuera_de_alcance`.
- Los checks los corre la máquina; sin pasarlos no hay commit ni entrenamiento
  (`checks_fallidos` tras 3 intentos).
- Si el meta-agente toca otro archivo o el bloque `<!-- protegido -->` de `program.md`,
  se revierte su cambio.
- Todas las tandas del loop externo parten del mismo commit, para comparar versiones
  de `program.md` en igualdad.
