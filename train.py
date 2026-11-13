"""Editable: el agente cambia todo lo que quiera aquí."""
import time

import numpy as np

from prepare import TIEMPO_SEGUNDOS, cargar_entrenamiento, evaluar

x, y = cargar_entrenamiento()
rng = np.random.default_rng(0)

# Línea base: regresión lineal con SGD por mini-batches.
w = np.zeros(x.shape[1], dtype=np.float32)
b = 0.0
lr = 0.01
batch = 256

inicio = time.time()
pasos = 0
while time.time() - inicio < TIEMPO_SEGUNDOS:
    idx = rng.integers(0, len(x), batch)
    xb, yb = x[idx], y[idx]
    err = xb @ w + b - yb
    w -= lr * (xb.T @ err) / batch
    b -= lr * err.mean()
    pasos += 1
segundos = time.time() - inicio


def predecir(xs):
    return xs @ w + b


print("---")
print(f"val_loss:          {evaluar(predecir):.6f}")
print(f"training_seconds:  {segundos:.1f}")
print(f"num_steps:         {pasos}")
print(f"num_params:        {w.size + 1}")
