---
name: write-checks
description: Escribe los checks de una feature de features.md antes de que exista el código. Recibe el id de la feature.
---

# write-checks

Feature: `$ARGUMENTS`

Los checks se escriben **antes** del código: describen qué tiene que cumplir la feature y hoy
deberían fallar. Una persona los va a revisar y aprobar; después nadie puede cambiarlos.

1. Leer en `features.md` la sección `## <id>`: es el pedido.
2. Leer `program.md` si existe: tiene las reglas del repo.
3. Recorrer el código para entender dónde va a vivir la feature y cómo se ejecuta.
4. Escribir los checks en `checks/<id>/`:
   - Un archivo por comportamiento, con nombre que lo describa (`01-crea-usuario.py`).
   - Extensiones válidas: `.py`, `.sh`, `.js`, `.mjs`, `.ts`. Otras no se ejecutan.
   - Cada archivo corre desde la raíz del repo, sale con 0 si el comportamiento se cumple
     y con otro código si no, e imprime por qué falló.
   - Verificar comportamiento observable, no detalles de implementación.
   - Cada check debe terminar en pocos segundos.

No tocar nada fuera de `checks/<id>/`: si se toca otro archivo, se descarta todo el trabajo.
No implementar la feature.

Al terminar, responder con una sola línea: qué cubren los checks.
