// Loop interno: la máquina corre el ciclo; el agente escribe checks y construye el cambio.
//
//   siguiente → escribiendoChecks → aislandoChecks → construyendo → verificando → corriendoChecks
//       ↑                                                ↑                             │ pasan
//       │                                                └─── fallan (quedan intentos) ┤
//       │                                                                              ↓
//       └──────────────────── checksFallidos (sin intentos) | conservando (commit) ←───┘
//
// No hay entrenamiento: un cambio cuyos checks pasan se conserva. El resultado de la corrida
// es cuántas iteraciones se conservaron; el loop externo lo usa para comparar program.md.
// Todo efecto pasa por los puertos: Agente y Checks llegan a la fábrica; Repositorio y
// Bitacora llegan en el input, porque cambian con cada worktree.
import { assign, fromPromise, setup } from "xstate";
import { CHECKS, descripcionDe, encargoBuild, encargoChecks } from "./encargos.ts";
import {
  costoDe,
  type Agente,
  type Bitacora,
  type Checks,
  type Encargo,
  type Repositorio,
  type Respuesta,
  type ResultadoChecks,
} from "./puertos.ts";

export interface PuertosInterno {
  agente: Agente;
  checks: Checks;
}

export interface EntradaInterno {
  repositorio: Repositorio; // worktree donde se trabaja
  bitacora: Bitacora; // results.tsv de esta corrida
  programa: string; // program.md vigente (lo entrega el loop externo)
  maxIteraciones: number;
  minutos: number;
  topeUsd: number; // gasto máximo de la corrida; Infinity = sin tope
}

export interface SalidaInterno {
  conservados: number; // iteraciones cuyos checks pasaron y quedaron commiteadas
  iteraciones: number;
  costoUsd: number;
}

export const ENCABEZADO_RESULTADOS = ["commit", "status", "description"] as const;

export type Estado = "keep" | "fuera_de_alcance" | "checks_fallidos" | "fallo_agente";

/** Intentos de construcción por iteración antes de rendirse con los checks. */
export const INTENTOS_BUILD = 3;

interface Contexto extends EntradaInterno {
  finEn: number;
  iteracion: number;
  intento: number;
  conservados: number;
  costoUsd: number;
  descripcion: string;
  fallo: string | null; // salida de los checks del intento anterior
}

function registrar(c: Contexto, estado: Estado, commit = "-", descripcion = c.descripcion) {
  c.bitacora.anotar([commit, estado, descripcion]);
}

export function crearMaquinaInterna(puertos: PuertosInterno) {
  return setup({
    types: {
      input: {} as EntradaInterno,
      context: {} as Contexto,
      output: {} as SalidaInterno,
    },
    actors: {
      agente: fromPromise<Respuesta, Encargo>(({ input, signal }) => puertos.agente.respuesta(input, signal)),
      checks: fromPromise<ResultadoChecks, string>(({ input }) => puertos.checks.resultado(input)),
    },
    guards: {
      // La fase de checks solo tocó checks/, y algo tocó.
      checksEnAlcance: ({ context }) => {
        const tocados = context.repositorio.tocados();
        return tocados.length > 0 && tocados.every((r) => r.startsWith(CHECKS));
      },
      // La fase de construcción cambió algo y no tocó checks/ (los checks ya están en el index).
      buildEnAlcance: ({ context }) => {
        const tocados = context.repositorio.tocadosFueraDelIndex();
        return tocados.length > 0 && !tocados.some((r) => r.startsWith(CHECKS));
      },
      quedanIntentos: ({ context }) => context.intento < INTENTOS_BUILD,
      quedaPresupuesto: ({ context }) =>
        context.iteracion < context.maxIteraciones &&
        Date.now() < context.finEn &&
        context.costoUsd < context.topeUsd,
    },
    actions: {
      // Lo gastado por una llamada fallida también cuenta.
      sumarCostoDelFallo: assign(({ context, event }) => ({
        costoUsd: context.costoUsd + costoDe((event as { error?: unknown }).error),
      })),
      // Un fallo del agente deja fila: si no, un tope agotado consumiría iteraciones en silencio.
      falloDeAgente: ({ context, event }) => {
        const error = (event as { error?: unknown }).error;
        const motivo = error instanceof Error ? error.message : String(error);
        registrar(context, "fallo_agente", "-", context.descripcion || motivo);
        context.repositorio.descartar();
      },
      fueraDeAlcance: ({ context }) => {
        registrar(context, "fuera_de_alcance");
        context.repositorio.descartar();
      },
    },
  }).createMachine({
    id: "interno",
    context: ({ input }) => ({
      ...input,
      finEn: Date.now() + input.minutos * 60_000,
      iteracion: 0,
      intento: 0,
      conservados: 0,
      costoUsd: 0,
      descripcion: "",
      fallo: null,
    }),
    initial: "siguiente",
    states: {
      // 1. Write checks: el agente decide el cambio y escribe en checks/ lo que debe cumplir.
      escribiendoChecks: {
        entry: assign(({ context }) => ({
          iteracion: context.iteracion + 1,
          intento: 0,
          descripcion: "",
          fallo: null,
        })),
        invoke: {
          src: "agente",
          input: ({ context }) =>
            encargoChecks(context.repositorio.directorio(), context.programa, context.bitacora.texto()),
          onDone: {
            target: "aislandoChecks",
            actions: assign(({ context, event }) => ({
              descripcion: descripcionDe(event.output.texto),
              costoUsd: context.costoUsd + event.output.costoUsd,
            })),
          },
          // Si el agente falla, se anota, se descarta lo que haya dejado y se sigue.
          onError: { target: "siguiente", actions: ["sumarCostoDelFallo", "falloDeAgente"] },
        },
      },
      // Los checks pasan al index: así se detecta si la construcción los toca.
      aislandoChecks: {
        always: [
          {
            guard: "checksEnAlcance",
            target: "construyendo",
            actions: ({ context }) => context.repositorio.aislar(CHECKS),
          },
          { target: "siguiente", actions: "fueraDeAlcance" },
        ],
      },
      // 2. Build: el agente implementa el cambio; si viene de un fallo, recibe la salida de los checks.
      construyendo: {
        entry: assign(({ context }) => ({ intento: context.intento + 1 })),
        invoke: {
          src: "agente",
          input: ({ context }) =>
            encargoBuild(context.repositorio.directorio(), context.programa, context.descripcion, context.fallo),
          onDone: {
            target: "verificando",
            actions: assign(({ context, event }) => ({ costoUsd: context.costoUsd + event.output.costoUsd })),
          },
          onError: { target: "siguiente", actions: ["sumarCostoDelFallo", "falloDeAgente"] },
        },
      },
      verificando: {
        always: [
          { guard: "buildEnAlcance", target: "corriendoChecks" },
          { target: "siguiente", actions: "fueraDeAlcance" },
        ],
      },
      // 3. Pass checks: los corre la máquina. Si pasan, se conserva; si no, se reintenta el build.
      corriendoChecks: {
        invoke: {
          src: "checks",
          input: ({ context }) => context.repositorio.directorio(),
          onDone: [
            { guard: ({ event }) => event.output.ok, target: "conservando" },
            {
              guard: "quedanIntentos",
              target: "construyendo",
              actions: assign(({ event }) => ({ fallo: event.output.salida })),
            },
            { target: "checksFallidos" },
          ],
          onError: { target: "checksFallidos" },
        },
      },
      checksFallidos: {
        entry: ({ context }) => {
          registrar(context, "checks_fallidos");
          context.repositorio.descartar();
        },
        always: "siguiente",
      },
      conservando: {
        entry: [
          ({ context }) => {
            context.repositorio.confirmar(context.descripcion, ["."]);
            registrar(context, "keep", context.repositorio.commitCorto());
          },
          assign(({ context }) => ({ conservados: context.conservados + 1 })),
        ],
        always: "siguiente",
      },
      siguiente: {
        always: [{ guard: "quedaPresupuesto", target: "escribiendoChecks" }, { target: "terminado" }],
      },
      terminado: { type: "final" },
    },
    output: ({ context }) => ({
      conservados: context.conservados,
      iteraciones: context.iteracion,
      costoUsd: context.costoUsd,
    }),
  });
}
