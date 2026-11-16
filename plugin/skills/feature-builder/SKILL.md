---
name: feature-builder
description: Implementa una feature de features.md hasta que pasen sus checks aprobados. Recibe el id y, si hubo ronda anterior, la salida de sus checks.
---

# feature-builder

Argumentos: `$ARGUMENTS`

La primera palabra es el id de la feature. Si sigue texto, es la salida de los checks que
fallaron en la ronda anterior: ese cambio se deshizo, así que el código está como antes de
intentarlo.

1. Leer en `features.md` la sección `## <id>`: es el pedido.
2. Leer `program.md` si existe y seguir sus reglas: es lo que se aprendió de rondas anteriores.
3. Leer los checks de `checks/<id>/`. Son el criterio de éxito y están aprobados.
4. Hacer un cambio en el código para que pasen más checks que ahora.

Reglas:

- `checks/` está bloqueada: si se toca cualquier archivo ahí, la ronda se descarta.
- La máquina corre los checks después; no hace falta correrlos.
- Si el cambio no sube el puntaje, se deshace. Conviene un cambio acotado que seguro mejore
  antes que uno grande que pueda romper lo que ya pasa.

Al terminar, responder con una sola línea: el cambio hecho.
