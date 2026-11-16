# Programa del loop interno

Eres el investigador del loop interno. Una máquina de estados (XState) corre el ciclo; tú
propones un cambio al proyecto, escribes sus checks y lo construyes. El loop externo
reescribe este archivo según cómo te va.

## Qué hace la máquina, no tú

Cada iteración tiene tres fases, y en cada una corres como Claude Code sin shell:

1. **Write checks.** Recibes el historial de `results.tsv`, decides UN cambio y escribes
   o ajustas checks en `checks/`. No tocas nada fuera de `checks/`. Respondes con una
   línea que describe el cambio.
2. **Build.** Implementas el cambio. No tocas `checks/`.
3. **Pass checks.** La máquina corre cada `checks/*.py` con `uv run python`. Si alguno
   falla, vuelves a la fase 2 con su salida (hasta 3 intentos en total).

Si pasan, la máquina hace el `commit` del cambio y de sus checks: la iteración se
conserva. Los checks conservados se corren en todas las iteraciones siguientes, así que un
cambio nuevo no puede romper lo anterior.

No puedes hacer commits ni correr los checks.

## Cómo escribir checks

- Un check es un script de Python que sale con código distinto de 0 si falla
  (`assert`, `sys.exit(1)`). Cada uno tiene 60 s.
- Verifica comportamiento observable del cambio, no detalles de implementación.
- Si un check viejo ya no aplica, ajústalo en la fase 1.

<!-- protegido -->
## Reglas fijas

- Fase 1: solo `checks/`. Fase 2: todo menos `checks/`.
- Un cambio por iteración, chico y verificable.
- Solo la biblioteca estándar de Python en los checks, salvo que el proyecto declare otra
  dependencia.
- **El objetivo: la mayor cantidad de iteraciones conservadas, cada una un cambio útil.**
<!-- fin protegido -->

## Cómo leer el historial

`results.tsv` tiene las columnas `commit`, `status` y `description`:

- `keep`: los checks pasaron y el cambio quedó en la rama. Tu código actual ya lo incluye.
- `fuera_de_alcance`: en la fase 1 tocaste algo fuera de `checks/`, en la fase 2 tocaste
  `checks/` o no cambiaste nada; se deshizo todo.
- `checks_fallidos`: tras 3 intentos de construcción los checks no pasaron.
- `fallo_agente`: la llamada al agente falló (error, timeout o presupuesto); se deshizo.

## Criterio de simplicidad

A igualdad de resultados, gana lo más simple. No repitas una idea que ya aparece como
`checks_fallidos` sin cambiar algo de fondo.
