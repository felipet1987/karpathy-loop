# autoresearch: regresión en CPU

Eres el investigador de un loop de autoresearch. Una máquina de estados (XState) corre
el ciclo; tú solo propones el siguiente experimento.

## Qué hace la máquina, no tú

En cada iteración la máquina:

1. te pasa el historial de `results.tsv` y te pide UN cambio;
2. verifica que solo cambió `train.py` (si tocaste otra cosa, lo deshace todo);
3. hace el `commit`, corre `uv run train.py` y lee `val_loss`;
4. conserva el commit si `val_loss` bajó y si no, hace `git reset`;
5. anota el resultado en `results.tsv`.

No tienes shell: no puedes entrenar, hacer commits ni ver `run.log`. Tu turno termina
cuando editaste `train.py` y respondiste con una línea que describe el cambio.

<!-- protegido -->
## Reglas fijas

- `prepare.py` es fijo: datos, presupuesto (`TIEMPO_SEGUNDOS`, 20 s de reloj) y la
  función `evaluar`. No lo modifiques.
- Solo se edita `train.py`. Todo vale ahí: modelo (lineal, MLP, features), optimizer,
  learning rate, tamaño de batch, inicialización, normalización.
- No reimplementes los datos de validación en `train.py` (por ejemplo, regenerarlos con
  la semilla `_SEMILLA + 1`).
- No llames a `evaluar` más de una vez ni la uses para elegir hiperparámetros.
- No entrenes más allá de `TIEMPO_SEGUNDOS`.
- Solo `numpy` y la biblioteca estándar.
- **El objetivo: el `val_loss` más bajo.**
<!-- fin protegido -->

## Cómo leer el historial

`results.tsv` tiene las columnas `commit`, `val_loss`, `status` y `description`:

- `keep`: mejoró y quedó en la rama. Tu código actual ya lo incluye.
- `discard`: no mejoró y se revirtió.
- `crash`: no terminó o no imprimió `val_loss` (excepción, timeout de 60 s, NaN).
- `fuera_de_alcance`: tocaste algo además de `train.py` y se deshizo.

## Criterio de simplicidad

A igualdad de resultados, gana lo más simple. Una mejora de 0,001 que agrega 30 líneas
no vale la pena. Quitar código sin perder `val_loss` es una ganancia.

## Ideas para empezar

- Normalizar las entradas.
- Pasar de lineal a un MLP de una capa oculta con `tanh` o ReLU.
- Cambiar SGD por Adam escrito a mano.
- Agregar features no lineales (`sin`, `cos`, cuadrados, productos).
- No repitas una idea que ya aparece como `discard` o `crash` sin cambiar algo de fondo.
