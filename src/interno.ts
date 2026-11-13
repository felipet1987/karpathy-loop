// Loop interno: la máquina corre el ciclo; el agente escribe checks y construye el cambio.
//
//   lineaBase → escribiendoChecks → aislandoChecks → construyendo → verificando → corriendoChecks
//                    ↑                                    ↑                              │ pasan
//                    │                                    └──── fallan (quedan intentos) ┤
//                    │                                                                   ↓
//                    └── siguiente (¿queda presupuesto?) ← conservando | revirtiendo ← entrenando
import { assign, fromPromise, setup } from "xstate";
import { cambiados, git, registrar } from "./git.ts";
import { CHECKS, EDITABLE } from "./nucleo/encargos.ts";
import type { Medicion, ResultadoChecks } from "./nucleo/puertos.ts";

export { CHECKS, EDITABLE, type Medicion, type ResultadoChecks };

export interface EntradaInterno {
  dir: string; // worktree donde se experimenta
  rutaPrograma: string; // program.md vigente (lo entrega el loop externo)
  maxIteraciones: number;
  minutos: number;
}

export interface SalidaInterno {
  lineaBase: number;
  mejor: number;
  iteraciones: number;
  costoUsd: number;
}

export interface EntradaEscribirChecks {
  dir: string;
  rutaPrograma: string;
}
export interface EntradaConstruir extends EntradaEscribirChecks {
  descripcion: string;
  fallo: string | null; // salida de los checks del intento anterior
}
export interface Propuesta {
  descripcion: string;
  costoUsd: number;
}

interface Contexto extends EntradaInterno {
  finEn: number;
  iteracion: number;
  intento: number;
  lineaBase: number;
  mejor: number;
  costoUsd: number;
  propuesta: Propuesta | null;
  fallo: string | null;
  medicion: Medicion | null;
}

/** Intentos de construcción por iteración antes de rendirse con los checks. */
export const INTENTOS_BUILD = 3;

const commitCorto = (dir: string) => git(dir, "rev-parse", "--short=7", "HEAD");

/** Deshace todo lo que no esté commiteado, incluido lo que esté en el index. */
function descartar(dir: string) {
  git(dir, "reset", "-q", "--hard", "HEAD");
  git(dir, "clean", "-fdq");
}

/** Cambios fuera del index: los que hizo la fase de construcción. */
function cambiadosFueraDelIndex(dir: string): string[] {
  const modificados = git(dir, "diff", "--name-only");
  const nuevos = git(dir, "ls-files", "--others", "--exclude-standard");
  return [modificados, nuevos].join("\n").split("\n").filter(Boolean);
}

export const maquinaInterna = setup({
  types: {
    input: {} as EntradaInterno,
    context: {} as Contexto,
    output: {} as SalidaInterno,
  },
  actors: {
    // Se reemplazan con .provide(): agentes.ts trae los reales y los tests traen falsos.
    escribirChecks: fromPromise<Propuesta, EntradaEscribirChecks>(async () => {
      throw new Error("falta el actor escribirChecks");
    }),
    construir: fromPromise<{ costoUsd: number }, EntradaConstruir>(async () => {
      throw new Error("falta el actor construir");
    }),
    correrChecks: fromPromise<ResultadoChecks, { dir: string }>(async () => {
      throw new Error("falta el actor correrChecks");
    }),
    entrenar: fromPromise<Medicion, { dir: string }>(async () => {
      throw new Error("falta el actor entrenar");
    }),
  },
  guards: {
    // La fase de checks solo tocó checks/, y algo tocó.
    checksEnAlcance: ({ context }) => {
      const tocados = cambiados(context.dir);
      return tocados.length > 0 && tocados.every((r) => r.startsWith(CHECKS));
    },
    // La fase de construcción solo tocó train.py (los checks ya están en el index).
    buildEnAlcance: ({ context }) => {
      const tocados = cambiadosFueraDelIndex(context.dir);
      return tocados.length === 1 && tocados[0] === EDITABLE;
    },
    quedanIntentos: ({ context }) => context.intento < INTENTOS_BUILD,
    mejoro: ({ context }) => context.medicion!.valLoss < context.mejor,
    quedaPresupuesto: ({ context }) =>
      context.iteracion < context.maxIteraciones && Date.now() < context.finEn,
  },
  actions: {
    descartar: ({ context }) => descartar(context.dir),
    fueraDeAlcance: ({ context }) => {
      registrar(context.dir, {
        commit: "-",
        valLoss: Infinity,
        status: "fuera_de_alcance",
        descripcion: context.propuesta!.descripcion,
      });
      descartar(context.dir);
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
    propuesta: null,
    fallo: null,
    medicion: null,
  }),
  initial: "lineaBase",
  states: {
    lineaBase: {
      invoke: {
        src: "entrenar",
        input: ({ context }) => ({ dir: context.dir }),
        onDone: {
          target: "siguiente",
          actions: [
            assign(({ event }) => ({ lineaBase: event.output.valLoss, mejor: event.output.valLoss })),
            ({ context, event }) =>
              registrar(context.dir, {
                commit: commitCorto(context.dir),
                valLoss: event.output.valLoss,
                status: "keep",
                descripcion: "linea base",
              }),
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
        propuesta: null,
        fallo: null,
        medicion: null,
      })),
      invoke: {
        src: "escribirChecks",
        input: ({ context }) => ({ dir: context.dir, rutaPrograma: context.rutaPrograma }),
        onDone: {
          target: "aislandoChecks",
          actions: assign(({ context, event }) => ({
            propuesta: event.output,
            costoUsd: context.costoUsd + event.output.costoUsd,
          })),
        },
        // Si el agente falla, se descarta lo que haya dejado y se sigue.
        onError: { target: "siguiente", actions: "descartar" },
      },
    },
    // Los checks pasan al index: así se detecta si la construcción los toca.
    aislandoChecks: {
      always: [
        {
          guard: "checksEnAlcance",
          target: "construyendo",
          actions: ({ context }) => git(context.dir, "add", "-A", "--", CHECKS),
        },
        { target: "siguiente", actions: "fueraDeAlcance" },
      ],
    },
    // 2. Build: el agente cambia train.py; si viene de un fallo, recibe la salida de los checks.
    construyendo: {
      entry: assign(({ context }) => ({ intento: context.intento + 1 })),
      invoke: {
        src: "construir",
        input: ({ context }) => ({
          dir: context.dir,
          rutaPrograma: context.rutaPrograma,
          descripcion: context.propuesta!.descripcion,
          fallo: context.fallo,
        }),
        onDone: {
          target: "verificando",
          actions: assign(({ context, event }) => ({ costoUsd: context.costoUsd + event.output.costoUsd })),
        },
        onError: { target: "siguiente", actions: "descartar" },
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
        src: "correrChecks",
        input: ({ context }) => ({ dir: context.dir }),
        onDone: [
          {
            guard: ({ event }) => event.output.ok,
            target: "entrenando",
            actions: ({ context }) => {
              git(context.dir, "add", "-A", "--", EDITABLE, CHECKS);
              git(context.dir, "commit", "-qm", context.propuesta!.descripcion);
            },
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
        registrar(context.dir, {
          commit: "-",
          valLoss: Infinity,
          status: "checks_fallidos",
          descripcion: context.propuesta!.descripcion,
        });
        descartar(context.dir);
      },
      always: "siguiente",
    },
    entrenando: {
      invoke: {
        src: "entrenar",
        input: ({ context }) => ({ dir: context.dir }),
        onDone: { target: "evaluando", actions: assign(({ event }) => ({ medicion: event.output })) },
        onError: {
          target: "siguiente",
          actions: ({ context }) => {
            registrar(context.dir, {
              commit: commitCorto(context.dir),
              valLoss: Infinity,
              status: "crash",
              descripcion: context.propuesta!.descripcion,
            });
            git(context.dir, "reset", "-q", "--hard", "HEAD~1");
          },
        },
      },
    },
    evaluando: {
      always: [{ guard: "mejoro", target: "conservando" }, { target: "revirtiendo" }],
    },
    conservando: {
      entry: [
        ({ context }) =>
          registrar(context.dir, {
            commit: commitCorto(context.dir),
            valLoss: context.medicion!.valLoss,
            status: "keep",
            descripcion: context.propuesta!.descripcion,
          }),
        assign(({ context }) => ({ mejor: context.medicion!.valLoss })),
      ],
      always: "siguiente",
    },
    revirtiendo: {
      entry: ({ context }) => {
        registrar(context.dir, {
          commit: commitCorto(context.dir),
          valLoss: context.medicion!.valLoss,
          status: "discard",
          descripcion: context.propuesta!.descripcion,
        });
        git(context.dir, "reset", "-q", "--hard", "HEAD~1");
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
