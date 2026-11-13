// Loop interno: la máquina corre el ciclo; el agente solo propone un cambio a train.py.
//
//   lineaBase → proponiendo → verificando → entrenando → evaluando → conservando | revirtiendo
//                    ↑                                                              │
//                    └──────────────── siguiente (¿queda presupuesto?) ←────────────┘
import { assign, fromPromise, setup } from "xstate";
import { cambiados, git, registrar } from "./git.ts";

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

export interface EntradaProponer {
  dir: string;
  rutaPrograma: string;
}
export interface Propuesta {
  descripcion: string;
  costoUsd: number;
}
export interface Medicion {
  valLoss: number;
}

interface Contexto extends EntradaInterno {
  finEn: number;
  iteracion: number;
  lineaBase: number;
  mejor: number;
  costoUsd: number;
  propuesta: Propuesta | null;
  medicion: Medicion | null;
}

/** El único archivo que el agente puede tocar. */
export const EDITABLE = "train.py";

const commitCorto = (dir: string) => git(dir, "rev-parse", "--short=7", "HEAD");

export const maquinaInterna = setup({
  types: {
    input: {} as EntradaInterno,
    context: {} as Contexto,
    output: {} as SalidaInterno,
  },
  actors: {
    // Se reemplazan con .provide(): agentes.ts trae los reales y los tests traen falsos.
    proponer: fromPromise<Propuesta, EntradaProponer>(async () => {
      throw new Error("falta el actor proponer");
    }),
    entrenar: fromPromise<Medicion, { dir: string }>(async () => {
      throw new Error("falta el actor entrenar");
    }),
    // Alcance: solo train.py cambió. Si cumple, hace el commit; si no, deshace todo.
    verificarYCommitear: fromPromise<boolean, { dir: string; descripcion: string }>(
      async ({ input }) => {
        const tocados = cambiados(input.dir);
        if (tocados.length === 1 && tocados[0] === EDITABLE) {
          git(input.dir, "commit", "-qam", input.descripcion);
          return true;
        }
        git(input.dir, "checkout", "-q", "--", ".");
        git(input.dir, "clean", "-fdq");
        return false;
      },
    ),
  },
  guards: {
    mejoro: ({ context }) => context.medicion!.valLoss < context.mejor,
    quedaPresupuesto: ({ context }) =>
      context.iteracion < context.maxIteraciones && Date.now() < context.finEn,
  },
}).createMachine({
  id: "interno",
  context: ({ input }) => ({
    ...input,
    finEn: Date.now() + input.minutos * 60_000,
    iteracion: 0,
    lineaBase: Infinity,
    mejor: Infinity,
    costoUsd: 0,
    propuesta: null,
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
    proponiendo: {
      entry: assign(({ context }) => ({ iteracion: context.iteracion + 1, propuesta: null, medicion: null })),
      invoke: {
        src: "proponer",
        input: ({ context }) => ({ dir: context.dir, rutaPrograma: context.rutaPrograma }),
        onDone: {
          target: "verificando",
          actions: assign(({ context, event }) => ({
            propuesta: event.output,
            costoUsd: context.costoUsd + event.output.costoUsd,
          })),
        },
        // Si el agente falla, se descarta lo que haya dejado y se sigue.
        onError: {
          target: "siguiente",
          actions: ({ context }) => {
            git(context.dir, "checkout", "-q", "--", ".");
            git(context.dir, "clean", "-fdq");
          },
        },
      },
    },
    verificando: {
      invoke: {
        src: "verificarYCommitear",
        input: ({ context }) => ({ dir: context.dir, descripcion: context.propuesta!.descripcion }),
        onDone: [
          { guard: ({ event }) => event.output, target: "entrenando" },
          {
            target: "siguiente",
            actions: ({ context }) =>
              registrar(context.dir, {
                commit: "-",
                valLoss: Infinity,
                status: "fuera_de_alcance",
                descripcion: context.propuesta!.descripcion,
              }),
          },
        ],
      },
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
      always: [{ guard: "quedaPresupuesto", target: "proponiendo" }, { target: "terminado" }],
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
