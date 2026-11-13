# autoresearch: regresión en CPU

Eres el investigador de un loop de autoresearch. Una máquina de estados (XState) corre
el ciclo; tú propones el experimento, escribes sus checks y lo construyes.

## Qué hace la máquina, no tú

Cada iteración tiene tres fases, y en cada una corres como Claude Code sin shell:

1. **Write checks.** Recibes el historial de `results.tsv`, decides UN cambio a
   `train.py` y escribes o ajustas checks en `checks/`. No tocas `train.py`. Respondes
   con una línea que describe el cambio.
2. **Build.** Implementas ese cambio en `train.py`. No tocas `checks/`.
3. **Pass checks.** La máquina corre cada `checks/*.py` con `uv run python`. Si alguno
   falla, vuelves a la fase 2 con su salida (hasta 3 intentos en total).

Si pasan, la máquina hace el `commit` de `train.py` y `checks/`, corre `uv run train.py`,
lee `val_loss` y conserva el commit si bajó; si no, hace `git reset`. Los checks de los
cambios conservados se quedan y se corren en todas las iteraciones siguientes.

No puedes entrenar, hacer commits, correr los checks ni ver `run.log`.

## Cómo escribir checks

- Un check es un script de Python que sale con código distinto de 0 si falla
  (`assert`, `sys.exit(1)`). Cada uno tiene 60 s.
- Verifica que el cambio quedó bien hecho: formas, que no haya NaN, que un gradiente
  coincida con diferencias finitas. Importar `train.py` lo entrena entero (20 s): si el
  check necesita sus funciones, conviene que `train.py` las defina antes del loop y que
  el loop corra solo bajo `if __name__ == "__main__":`.
- Si un check viejo ya no aplica a la idea nueva, ajústalo en la fase 1.

<!-- protegido -->
## Reglas fijas

- `prepare.py` es fijo: datos, presupuesto (`TIEMPO_SEGUNDOS`, 20 s de reloj) y la
  función `evaluar`. No lo modifiques.
- Solo se editan `train.py` y `checks/`. En `train.py` todo vale: modelo (lineal, MLP,
  features), optimizer, learning rate, tamaño de batch, inicialización, normalización.
- No reimplementes los datos de validación en `train.py` (por ejemplo, regenerarlos con
  la semilla `_SEMILLA + 1`).
- No llames a `evaluar` más de una vez ni la uses para elegir hiperparámetros.
- No entrenes más allá de `TIEMPO_SEGUNDOS`.
- Los checks no llaman a `evaluar` ni usan los datos de validación.
- Solo `numpy` y la biblioteca estándar.
- **El objetivo: el `val_loss` más bajo.**
<!-- fin protegido -->

## Cómo leer el historial

`results.tsv` tiene las columnas `commit`, `val_loss`, `status` y `description`:

- `keep`: mejoró y quedó en la rama. Tu código actual ya lo incluye.
- `discard`: no mejoró y se revirtió.
- `crash`: no terminó o no imprimió `val_loss` (excepción, timeout de 60 s, NaN).
- `fuera_de_alcance`: en la fase 1 tocaste algo fuera de `checks/`, o en la fase 2 algo
  además de `train.py`; se deshizo todo.
- `checks_fallidos`: tras 3 intentos de construcción los checks no pasaron.

## Criterio de simplicidad

A igualdad de resultados, gana lo más simple. Una mejora de 0,001 que agrega 30 líneas
no vale la pena. Quitar código sin perder `val_loss` es una ganancia.

## Ideas para empezar

- Normalizar las entradas.
- Pasar de lineal a un MLP de una capa oculta con `tanh` o ReLU.
- Cambiar SGD por Adam escrito a mano.
- Agregar features no lineales (`sin`, `cos`, cuadrados, productos).
- No repitas una idea que ya aparece como `discard` o `crash` sin cambiar algo de fondo.
