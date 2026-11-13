# autoresearch: regresión en CPU (loop interno)

Este es un experimento para que el agente investigue solo. Corre en CPU en segundos,
así que sirve para ver el loop completo sin GPU.

## Preparación

1. La etiqueta de corrida la da el humano (o el loop externo) en el mensaje inicial.
   La rama `autoresearch/<etiqueta>` no debe existir.
2. `git checkout -b autoresearch/<etiqueta>` desde el commit actual. Si ya se está en
   esa rama (el loop externo la crea con un worktree), seguir en ella.
3. Leer los archivos del alcance:
   - `prepare.py`: fijo. Datos, presupuesto (`TIEMPO_SEGUNDOS`) y la función `evaluar`.
   - `train.py`: el archivo que se modifica.
4. Crear `results.tsv` solo con el encabezado.
5. Si el mensaje inicial dice que la preparación está confirmada, arrancar sin preguntar.

<!-- protegido -->
## Reglas fijas

Cada experimento se lanza con `uv run train.py > run.log 2>&1`. El entrenamiento dura
**`TIEMPO_SEGUNDOS` (20 s) de reloj**, más unos segundos de arranque.

**Lo que SE PUEDE hacer:** modificar `train.py`. Todo vale: modelo (lineal, MLP,
features), optimizer, learning rate, tamaño de batch, inicialización, normalización.

**Lo que NO se puede hacer:**
- Modificar `prepare.py` ni reimplementar sus datos de validación en `train.py`
  (por ejemplo, regenerarlos con la semilla `_SEMILLA + 1`).
- Llamar a `evaluar` más de una vez por corrida ni usarla para elegir hiperparámetros.
- Entrenar más allá de `TIEMPO_SEGUNDOS`.
- Instalar paquetes: solo `numpy` y la biblioteca estándar.

**El objetivo: el `val_loss` más bajo.**

**NEVER STOP**: una vez empezado el ciclo, no preguntar si conviene seguir. El ciclo
sigue hasta que lo interrumpan.
<!-- fin protegido -->

## Criterio de simplicidad

A igualdad de resultados, gana lo más simple. Una mejora de 0,001 que agrega 30 líneas
no vale la pena. Quitar código sin perder `val_loss` es una ganancia.

## Salida

`train.py` imprime:

```
---
val_loss:          1.101383
training_seconds:  20.0
num_steps:         1456247
num_params:        7
```

Se lee con `grep "^val_loss:" run.log`.

## Registro

`results.tsv`, separado por tabulaciones y fuera de git:

```
commit	val_loss	status	description
```

`status` es `keep`, `discard` o `crash`. En un crash, `val_loss` va como `inf`.

## El ciclo

REPETIR SIEMPRE:

1. Revisar el estado de git.
2. Editar `train.py` con una idea y hacer `git commit`.
3. `uv run train.py > run.log 2>&1` (nunca `tee`).
4. `grep "^val_loss:" run.log`. Si sale vacío, leer `tail -n 30 run.log`; si el error
   es tonto, corregir y repetir una vez; si no, registrar `crash`.
5. Anotar en `results.tsv`.
6. Si `val_loss` bajó, conservar el commit (`keep`).
7. Si quedó igual o subió, `git reset --hard HEAD~1` (`discard`).

La primera corrida es siempre la línea base, con `train.py` sin cambios.

Si una corrida pasa de 60 segundos, cortarla y tratarla como `crash`.

## Ideas para empezar

- Normalizar las entradas.
- Pasar de lineal a un MLP de una capa oculta con `tanh` o ReLU.
- Cambiar SGD por Adam escrito a mano.
- Agregar features no lineales (`sin`, `cos`, cuadrados, productos).
