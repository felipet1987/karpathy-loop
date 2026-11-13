"""Fijo: datos, presupuesto y evaluación. El agente NO modifica este archivo."""
import numpy as np

TIEMPO_SEGUNDOS = 20  # presupuesto de entrenamiento por experimento (reloj)
_SEMILLA = 1234


def _generar(n, rng):
    x = rng.uniform(-2, 2, size=(n, 6))
    y = (np.sin(3 * x[:, 0]) * np.cos(2 * x[:, 1])
         + 0.5 * x[:, 2] ** 2
         - np.abs(x[:, 3]) * x[:, 4]
         + 0.1 * rng.standard_normal(n))
    return x.astype(np.float32), y.astype(np.float32)


def cargar_entrenamiento():
    """Devuelve (x, y) de entrenamiento: 20.000 filas, 6 columnas."""
    return _generar(20_000, np.random.default_rng(_SEMILLA))


def evaluar(predecir):
    """Métrica oficial: error cuadrático medio en validación. Más bajo es mejor.

    `predecir` recibe un array (n, 6) y devuelve un array (n,).
    """
    x, y = _generar(5_000, np.random.default_rng(_SEMILLA + 1))
    pred = np.asarray(predecir(x), dtype=np.float64).reshape(-1)
    if pred.shape != y.shape or not np.all(np.isfinite(pred)):
        return float("inf")
    return float(np.mean((pred - y) ** 2))
