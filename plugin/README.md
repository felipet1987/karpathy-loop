# Plugin `kl`

Skills de Claude Code del flujo por feature de karpathy-loop. `src/composicion.ts` las carga con
`claude -p --plugin-dir plugin/` solo durante cada llamada: no se instalan ni aparecen en
otras sesiones.

| Skill | La invoca | Argumentos | Puede tocar |
|---|---|---|---|
| `kl:write-checks` | `feature checks <id>` | `<id>` | solo `checks/<id>/` |
| `kl:feature-builder` | `feature aprobar <id>`, una vez por ronda | `<id>` y, si la ronda anterior falló, la salida de sus checks | todo menos `checks/` |
| `kl:auto-loop` | `feature mejorar` | ninguno | solo `program.md` |

Las restricciones de la última columna no dependen del prompt: la máquina revisa lo que
quedó modificado después de cada llamada y descarta o revierte si se salió de su alcance.

## Qué lee cada skill

- `features.md`: el pedido, una sección `## <id>` por feature.
- `program.md`: reglas del repo y lo aprendido en rondas anteriores. También llega como
  system prompt.
- `checks/<id>/`: los checks aprobados (feature-builder, solo lectura).
- `.kl/rondas/*.tsv` y `.kl/reportes/*.md`: el registro de rondas (auto-loop).

## Contrato de los checks

Cada archivo de `checks/<id>/` con extensión `.py`, `.sh`, `.js`, `.mjs` o `.ts` es un
check. Corre desde la raíz del repo, pasa si sale con 0 e imprime por qué falló. Los
archivos con otra extensión (por ejemplo, notas en `.md`) no se ejecutan.

## Probar una skill a mano

Dentro del repo destino:

```bash
claude --plugin-dir /ruta/a/karpathy-loop/plugin
> /kl:write-checks <id>
```

## Cambiar una skill

Se edita su `SKILL.md`. `$ARGUMENTS` recibe todo lo que sigue al nombre del comando,
incluidas varias líneas. La última línea de la respuesta se guarda como descripción en el
registro de rondas y en el mensaje del commit, así que cada skill termina con una sola
línea de resumen.
