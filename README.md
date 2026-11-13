# karpathy-loop

Los dos loops de autoresearch como máquinas XState v5. A diferencia del repo de
Karpathy, aquí el ciclo lo corre la máquina y el agente solo propone cambios.

| Archivo            | Rol                                                            |
|--------------------|----------------------------------------------------------------|
| `prepare.py`       | fijo: datos, presupuesto de 20 s y `evaluar` (`val_loss`)      |
| `train.py`         | lo único que edita el investigador                             |
| `program.md`       | system prompt del investigador; lo reescribe el loop externo   |
| `meta-prompt.md`   | system prompt del meta-agente del loop externo                 |
| `src/interno.ts`   | máquina del loop interno                                       |
| `src/externo.ts`   | máquina del loop externo; invoca la interna como actor hijo    |
| `src/agentes.ts`   | actores reales: `uv run train.py` y agentes del Agent SDK      |

## Uso

```bash
npm install
npm test                                   # máquinas con agentes falsos, sin cuota
node src/cli.ts interno --iteraciones 10   # un loop interno real
node src/cli.ts externo --versiones 4 --iteraciones 8
```

Cada iteración real llama a un agente y consume cuota. El repo tiene que estar sin
cambios: las máquinas hacen `checkout` y `reset`.

Los experimentos corren en worktrees bajo `.trabajo/` (rama `autoresearch/<etiqueta>`).
El loop externo deja `meta/historial.tsv` y `meta/resultados-v<n>.tsv`.

## Lo que la máquina garantiza y un prompt no

- El investigador no tiene shell: no puede entrenar, hacer commits ni leer la evaluación.
- Si toca algo además de `train.py`, se deshace todo (`fuera_de_alcance`).
- Si el meta-agente toca otro archivo o el bloque `<!-- protegido -->` de `program.md`,
  se revierte su cambio.
- Todas las tandas del loop externo parten del mismo commit, para comparar versiones
  de `program.md` en igualdad.
