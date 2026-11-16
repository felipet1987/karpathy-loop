---
name: auto-loop
description: Lee el registro de rondas de las features y mejora program.md con un cambio. No edita checks.
---

# auto-loop

No se construyen features aquí: se mejora `program.md`, que guía al feature-builder.

1. Leer `program.md`.
2. Leer el registro de rondas en `.kl/rondas/*.tsv`: cada fila tiene ronda, commit, puntaje
   (`pasados/total`), estado, checks que fallan y el cambio intentado. Leer también
   `.kl/reportes/*.md` si existen.
3. Buscar hábitos repetidos:
   - el mismo check falla en muchas rondas;
   - muchas rondas `deshecho` (cambios que no suben el puntaje) o `sin_cambios`;
   - rondas `fuera_de_alcance` (el builder tocó `checks/`);
   - `fallo_agente` repetido (cambios demasiado largos o presupuesto agotado).
4. Hacer **un** cambio a `program.md` que ataque el hábito más costoso: una regla, una
   prohibición o una heurística concreta.

Solo se puede editar `program.md`. Si se toca cualquier otro archivo, sobre todo `checks/`,
se revierte todo.

Al terminar, responder con una línea: el cambio y la hipótesis.
