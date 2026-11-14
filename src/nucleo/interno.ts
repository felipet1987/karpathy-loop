// Loop interno: la máquina corre el ciclo; el agente escribe checks y construye el cambio.
//
//   lineaBase → escribiendoChecks → aislandoChecks → construyendo → verificando → corriendoChecks
//                    ↑                                    ↑                              │ pasan
//                    │                                    └──── fallan (quedan intentos) ┤
//                    │                                                                   ↓
//                    └── siguiente (¿queda presupuesto?) ← conservando | revirtiendo ← entrenando
//
// Todo efecto pasa por los puertos: Agente, Checks y Entrenador llegan a la fábrica;
// Repositorio y Bitacora llegan en el input, porque cambian con cada worktree.
import { assign, fromPromise, setup } from "xstate";
import { CHECKS, EDITABLE, descripcionDe, encargoBuild, encargoChecks } from "./encargos.ts";
import {
  costoDe,
  type Agente,
  type Bitacora,
  type Checks,
  type Encargo,
  type Entrenador,
  type Medicion,
  type Repositorio,
  type Respuesta,
  type ResultadoChecks,
} from "./puertos.ts";

export interface PuertosInterno {
  agente: Agente;
  checks: Checks;
  entrenador: Entrenador;
}

export interface EntradaInterno {
  repositorio: Repositorio; // worktree donde se experimenta
  bitacora: Bitacora; // results.tsv de esta corrida
  programa: string; // program.md vigente (lo entrega el loop externo)
  maxIteraciones: number;
  minutos: number;
}

export interface SalidaInterno {
  lineaBase: number;
  mejor: number;
  iteraciones: number;
  costoUsd: number;
}

export const ENCABEZADO_RESULTADOS = ["commit", "val_loss", "status", "description"] as const;

export type Estado = "keep" | "discard" | "crash" | "fuera_de_alcance" | "checks_fallidos";

/** Intentos de construcción por iteración antes de rendirse con los checks. */
export const INTENTOS_BUILD = 3;

interface Contexto extends EntradaInterno {
  finEn: number;
  iteracion: number;
  intento: number;
  lineaBase: number;
  mejor: number;
  costoUsd: number;
  descripcion: string;
  fallo: string | null; // salida de los checks del intento anterior
  medicion: Medicion | null;
}

function registrar(c: Contexto, estado: Estado, valLoss: number, commit = c.repositorio.commitCorto()) {
  c.bitacora.anotar([commit, valLoss.toFixed(6), estado, c.descripcion]);
}

export function crearMaquinaInterna(puertos: PuertosInterno) {
  return setup({
    types: {
      input: {} as EntradaInterno,
      context: {} as Contexto,
      output: {} as SalidaInterno,
    },
    actors: {
      agente: fromPromise<Respuesta, Encargo>(({ input }) => puertos.agente.respuesta(input)),
      checks: fromPromise<ResultadoChecks, string>(({ input }) => puertos.checks.resultado(input)),
      entrenar: fromPromise<Medicion, string>(({ input }) => puertos.entrenador.medicion(input)),
    },
    guards: {
      // La fase de checks solo tocó checks/, y algo tocó.
      checksEnAlcance: ({ context }) => {
        const tocados = context.repositorio.tocados();
        return tocados.length > 0 && tocados.every((r) => r.startsWith(CHECKS));
      },
      // La fase de construcción solo tocó train.py (los checks ya están en el index).
      buildEnAlcance: ({ context }) => {
        const tocados = context.repositorio.tocadosFueraDelIndex();
        return tocados.length === 1 && tocados[0] === EDITABLE;
      },
      quedanIntentos: ({ context }) => context.intento < INTENTOS_BUILD,
      mejoro: ({ context }) => context.medicion!.valLoss < context.mejor,
      quedaPresupuesto: ({ context }) =>
        context.iteracion < context.maxIteraciones && Date.now() < context.finEn,
    },
    actions: {
      descartar: ({ context }) => context.repositorio.descartar(),
      // Lo gastado por una llamada fallida también cuenta.
      sumarCostoDelFallo: assign(({ context, event }) => ({
        costoUsd: context.costoUsd + costoDe((event as { error?: unknown }).error),
      })),
      fueraDeAlcance: ({ context }) => {
        registrar(context, "fuera_de_alcance", Infinity, "-");
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
      lineaBase: Infinity,
      mejor: Infinity,
      costoUsd: 0,
      descripcion: "linea base",
      fallo: null,
      medicion: null,
    }),
    initial: "lineaBase",
    states: {
      lineaBase: {
        invoke: {
          src: "entrenar",
          input: ({ context }) => context.repositorio.directorio(),
          onDone: {
            target: "siguiente",
            actions: [
              assign(({ event }) => ({ lineaBase: event.output.valLoss, mejor: event.output.valLoss })),
              ({ context, event }) => registrar(context, "keep", event.output.valLoss),
            ],
          },
          onError: { target: "sinLineaBase" },
        },
      },
      // 1. Write checks: el agente decide el experimento y escribe en checks/ lo que debe cumplir.
      escribiendoChecks: {
        entry: assign(({ context }) => ({
          iteracion: context.iteracion + 1,
          intento: 0,
          descripcion: "",
          fallo: null,
          medicion: null,
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
          // Si el agente falla, se descarta lo que haya dejado y se sigue.
          onError: { target: "siguiente", actions: ["sumarCostoDelFallo", "descartar"] },
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
      // 2. Build: el agente cambia train.py; si viene de un fallo, recibe la salida de los checks.
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
          onError: { target: "siguiente", actions: ["sumarCostoDelFallo", "descartar"] },
        },
      },
      verificando: {
        always: [
          { guard: "buildEnAlcance", target: "corriendoChecks" },
          { target: "siguiente", actions: "fueraDeAlcance" },
        ],
      },
      // 3. Pass checks: los corre la máquina. Si pasan, commit de train.py + checks/ y a entrenar.
      corriendoChecks: {
        invoke: {
          src: "checks",
          input: ({ context }) => context.repositorio.directorio(),
          onDone: [
            {
              guard: ({ event }) => event.output.ok,
              target: "entrenando",
              actions: ({ context }) => context.repositorio.confirmar(context.descripcion, [EDITABLE, CHECKS]),
            },
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
          registrar(context, "checks_fallidos", Infinity, "-");
          context.repositorio.descartar();
        },
        always: "siguiente",
      },
      entrenando: {
        invoke: {
          src: "entrenar",
          input: ({ context }) => context.repositorio.directorio(),
          onDone: { target: "evaluando", actions: assign(({ event }) => ({ medicion: event.output })) },
          onError: {
            target: "siguiente",
            actions: ({ context }) => {
              registrar(context, "crash", Infinity);
              context.repositorio.revertirUltimo();
            },
          },
        },
      },
      evaluando: {
        always: [{ guard: "mejoro", target: "conservando" }, { target: "revirtiendo" }],
      },
      conservando: {
        entry: [
          ({ context }) => registrar(context, "keep", context.medicion!.valLoss),
          assign(({ context }) => ({ mejor: context.medicion!.valLoss })),
        ],
        always: "siguiente",
      },
      revirtiendo: {
        entry: ({ context }) => {
          registrar(context, "discard", context.medicion!.valLoss);
          context.repositorio.revertirUltimo();
        },
        always: "siguiente",
      },
      siguiente: {
        always: [{ guard: "quedaPresupuesto", target: "escribiendoChecks" }, { target: "terminado" }],
      },
      sinLineaBase: { type: "final" },
      terminado: { type: "final" },
    },
    output: ({ context }) => ({
      lineaBase: context.lineaBase,
      mejor: context.mejor,
      iteraciones: context.iteracion,
      costoUsd: context.costoUsd,
    }),
  });
}
