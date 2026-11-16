// Rondas por feature: con los checks ya aprobados y versionados, el builder (skill
// feature-builder, contexto limpio en cada ronda) cambia el código y la máquina lo puntúa.
//
//   puntuandoBase → construyendo → verificando → corriendoChecks → decidiendo
//                        ↑                                           │ todos pasan → completa
//                        └── siguiente ← conservando | deshaciendo ←─┘
//
// Conservar o deshacer: un cambio que sube el puntaje se commitea; uno que no, se deshace,
// y la salida de sus checks llega al builder de la ronda siguiente.
import { assign, fromPromise, setup } from "xstate";
import { descripcionDe } from "./encargos.ts";
import {
  costoDe,
  type Agente,
  type Bitacora,
  type Encargo,
  type Evaluador,
  type Puntaje,
  type Repositorio,
  type Respuesta,
} from "./puertos.ts";

export interface PuertosFeature {
  agente: Agente;
  evaluador: Evaluador;
}

export interface EntradaFeature {
  id: string;
  repositorio: Repositorio; // worktree de la feature, con los checks aprobados en HEAD
  bitacora: Bitacora; // registro de rondas de esta feature
  programa: string; // program.md: reglas y cómo trabajar
  maxRondas: number;
  topeUsd: number; // Infinity = sin tope
}

export interface SalidaFeature {
  id: string;
  completa: boolean; // todos los checks pasan
  puntaje: string; // "pasados/total" del último commit
  rondas: number;
  costoUsd: number;
}

export const ENCABEZADO_RONDAS = ["ronda", "commit", "puntaje", "estado", "fallos", "descripcion"] as const;

export type EstadoRonda = "base" | "conservado" | "deshecho" | "completa" | "fuera_de_alcance" | "sin_cambios" | "fallo_agente";

export const carpetaDeChecks = (id: string) => `checks/${id}/`;

/** Encargo del builder: la skill recibe el id y, si la ronda anterior falló, la salida de sus checks. */
export function encargoBuilder(dir: string, programa: string, id: string, fallo: string | null): Encargo {
  return {
    fase: "feature-builder",
    systemPrompt: programa,
    prompt: `/kl:feature-builder ${id}${fallo ? `\n\nSalida de los checks de la ronda anterior:\n\n${fallo}` : ""}`,
    cwd: dir,
    herramientas: ["Read", "Glob", "Grep", "Write", "Edit"],
  };
}

interface Contexto extends EntradaFeature {
  ronda: number;
  mejor: number;
  total: number;
  costoUsd: number;
  descripcion: string;
  fallo: string | null;
  puntaje: Puntaje | null;
}

function registrar(c: Contexto, estado: EstadoRonda, p: Puntaje | null, commit = c.repositorio.commitCorto()) {
  c.bitacora.anotar([
    String(c.ronda),
    commit,
    p ? `${p.pasados}/${p.total}` : "-",
    estado,
    p ? p.fallidos.join(",") : "-",
    c.descripcion,
  ]);
}

export function crearMaquinaFeature(puertos: PuertosFeature) {
  return setup({
    types: {
      input: {} as EntradaFeature,
      context: {} as Contexto,
      output: {} as SalidaFeature,
    },
    actors: {
      agente: fromPromise<Respuesta, Encargo>(({ input, signal }) => puertos.agente.respuesta(input, signal)),
      puntuar: fromPromise<Puntaje, { dir: string; carpeta: string }>(({ input, signal }) =>
        puertos.evaluador.puntaje(input.dir, input.carpeta, signal),
      ),
    },
    guards: {
      // Los checks quedan bloqueados: el builder no puede tocar nada bajo checks/.
      tocoChecks: ({ context }) => context.repositorio.tocados().some((r) => r.startsWith("checks/")),
      sinCambios: ({ context }) => context.repositorio.tocados().length === 0,
      todosPasan: ({ context }) => context.puntaje!.total > 0 && context.puntaje!.pasados === context.puntaje!.total,
      subio: ({ context }) => context.puntaje!.pasados > context.mejor,
      quedaPresupuesto: ({ context }) => context.ronda < context.maxRondas && context.costoUsd < context.topeUsd,
    },
  }).createMachine({
    id: "feature",
    context: ({ input }) => ({
      ...input,
      ronda: 0,
      mejor: 0,
      total: 0,
      costoUsd: 0,
      descripcion: "base",
      fallo: null,
      puntaje: null,
    }),
    initial: "puntuandoBase",
    states: {
      puntuandoBase: {
        invoke: {
          src: "puntuar",
          input: ({ context }) => ({ dir: context.repositorio.directorio(), carpeta: carpetaDeChecks(context.id) }),
          onDone: {
            target: "decidiendoBase",
            actions: [
              assign(({ event }) => ({
                puntaje: event.output,
                mejor: event.output.pasados,
                total: event.output.total,
                fallo: event.output.pasados < event.output.total ? event.output.salida : null,
              })),
              ({ context, event }) => registrar(context, "base", event.output),
            ],
          },
        },
      },
      decidiendoBase: {
        always: [{ guard: "todosPasan", target: "terminado" }, { target: "siguiente" }],
      },
      construyendo: {
        entry: assign(({ context }) => ({ ronda: context.ronda + 1, descripcion: "" })),
        invoke: {
          src: "agente",
          input: ({ context }) =>
            encargoBuilder(context.repositorio.directorio(), context.programa, context.id, context.fallo),
          onDone: {
            target: "verificando",
            actions: assign(({ context, event }) => ({
              descripcion: descripcionDe(event.output.texto),
              costoUsd: context.costoUsd + event.output.costoUsd,
            })),
          },
          onError: {
            target: "siguiente",
            actions: [
              assign(({ context, event }) => ({
                costoUsd: context.costoUsd + costoDe(event.error),
                descripcion: event.error instanceof Error ? event.error.message : String(event.error),
              })),
              ({ context }) => {
                registrar(context, "fallo_agente", null, "-");
                context.repositorio.descartar();
              },
            ],
          },
        },
      },
      verificando: {
        always: [
          {
            guard: "tocoChecks",
            target: "siguiente",
            actions: ({ context }) => {
              registrar(context, "fuera_de_alcance", null, "-");
              context.repositorio.descartar();
            },
          },
          {
            guard: "sinCambios",
            target: "siguiente",
            actions: ({ context }) => registrar(context, "sin_cambios", null, "-"),
          },
          { target: "corriendoChecks" },
        ],
      },
      corriendoChecks: {
        invoke: {
          src: "puntuar",
          input: ({ context }) => ({ dir: context.repositorio.directorio(), carpeta: carpetaDeChecks(context.id) }),
          onDone: {
            target: "decidiendo",
            actions: assign(({ event }) => ({ puntaje: event.output })),
          },
        },
      },
      decidiendo: {
        always: [
          { guard: "todosPasan", target: "completa" },
          { guard: "subio", target: "conservando" },
          { target: "deshaciendo" },
        ],
      },
      completa: {
        entry: [
          ({ context }) => {
            context.repositorio.confirmar(`${context.id}: ${context.descripcion}`, ["."]);
            registrar(context, "completa", context.puntaje);
          },
          assign(({ context }) => ({ mejor: context.puntaje!.pasados, fallo: null })),
        ],
        always: "terminado",
      },
      conservando: {
        entry: [
          ({ context }) => {
            context.repositorio.confirmar(`${context.id}: ${context.descripcion}`, ["."]);
            registrar(context, "conservado", context.puntaje);
          },
          assign(({ context }) => ({ mejor: context.puntaje!.pasados, fallo: context.puntaje!.salida })),
        ],
        always: "siguiente",
      },
      deshaciendo: {
        entry: [
          ({ context }) => {
            registrar(context, "deshecho", context.puntaje, "-");
            context.repositorio.descartar();
          },
          assign(({ context }) => ({ fallo: context.puntaje!.salida })),
        ],
        always: "siguiente",
      },
      siguiente: {
        always: [{ guard: "quedaPresupuesto", target: "construyendo" }, { target: "terminado" }],
      },
      terminado: { type: "final" },
    },
    output: ({ context }) => ({
      id: context.id,
      completa: context.total > 0 && context.mejor === context.total,
      puntaje: `${context.mejor}/${context.total}`,
      rondas: context.ronda,
      costoUsd: context.costoUsd,
    }),
  });
}
