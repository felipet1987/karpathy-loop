// Loop externo: mejora program.md corriendo el loop interno por tandas. Cada versión se juzga
// por cuántas iteraciones conservó su tanda; si supera a la mejor, su estado es «mejora» y se
// commitea; si no, «sin_mejora» y se restaura la anterior.
//
//   preparando → corriendoInterno → decidiendo → conservando | descartando → siguiente
//        ↑                                                                    │
//        └──── custodiando ← proponiendoPrograma ←──── (¿quedan versiones?) ───┘
import { assign, fromPromise, setup } from "xstate";
import { encargoPrograma } from "./encargos.ts";
import { crearMaquinaInterna, type PuertosInterno, type SalidaInterno } from "./interno.ts";
import { costoDe, type Bitacora, type Repositorio, type Respuesta } from "./puertos.ts";

export interface PuertosExterno extends PuertosInterno {
  repositorio: Repositorio; // raíz: program.md y meta-prompt.md
  historial: Bitacora; // meta/historial.tsv
  resultados: (version: number) => Bitacora; // meta/resultados-v<n>.tsv
}

export interface EntradaExterno {
  base: string; // commit del que parte cada tanda (todas parten del mismo)
  prefijo: string; // etiqueta de la corrida; cada tanda es <prefijo>-v<n>
  versiones: number;
  iteracionesPorTanda: number;
  minutosPorTanda: number;
  topeUsdPorTanda: number; // Infinity = sin tope
}

/** Estado de mejora de cada versión de program.md. */
export type EstadoVersion = "mejora" | "sin_mejora";

export interface SalidaExterno {
  mejorConservados: number;
  historial: { version: number; conservados: number; estado: EstadoVersion }[];
  costoUsd: number;
}

export const ENCABEZADO_HISTORIAL = ["version", "conservados", "estado"] as const;

const PROGRAMA = "program.md";

interface Contexto extends EntradaExterno {
  version: number;
  worktree: Repositorio | null;
  resultado: SalidaInterno | null;
  mejorConservados: number;
  historial: SalidaExterno["historial"];
  costoUsd: number;
}

const PROTEGIDO = /<!-- protegido -->[\s\S]*?<!-- fin protegido -->/;
export const bloqueProtegido = (texto: string) => texto.match(PROTEGIDO)?.[0] ?? null;

export function crearMaquinaExterna(puertos: PuertosExterno) {
  const { repositorio } = puertos;
  const anotar = (c: Contexto, estado: EstadoVersion) => {
    const conservados = c.resultado!.conservados;
    puertos.historial.anotar([`v${c.version}`, String(conservados), estado]);
    return { historial: [...c.historial, { version: c.version, conservados, estado }] };
  };

  return setup({
    types: {
      input: {} as EntradaExterno,
      context: {} as Contexto,
      output: {} as SalidaExterno,
    },
    actors: {
      interno: crearMaquinaInterna(puertos),
      // El meta-prompt se lee dentro del actor: si falta, cae en onError como un fallo del agente.
      reescribirPrograma: fromPromise<Respuesta>(async ({ signal }) =>
        puertos.agente.respuesta(
          encargoPrograma(repositorio.directorio(), repositorio.contenido("meta-prompt.md")),
          signal,
        ),
      ),
    },
    guards: {
      superaMejor: ({ context }) => context.resultado!.conservados > context.mejorConservados,
      quedanVersiones: ({ context }) => context.version < context.versiones,
    },
  }).createMachine({
    id: "externo",
    context: ({ input }) => ({
      ...input,
      version: 1,
      worktree: null,
      resultado: null,
      mejorConservados: 0,
      historial: [],
      costoUsd: 0,
    }),
    initial: "preparando",
    states: {
      preparando: {
        entry: assign(({ context }) => ({
          worktree: repositorio.worktree(`${context.prefijo}-v${context.version}`, context.base),
        })),
        always: "corriendoInterno",
      },
      corriendoInterno: {
        invoke: {
          src: "interno",
          input: ({ context }) => ({
            repositorio: context.worktree!,
            bitacora: puertos.resultados(context.version),
            programa: repositorio.contenido(PROGRAMA),
            maxIteraciones: context.iteracionesPorTanda,
            minutos: context.minutosPorTanda,
            topeUsd: context.topeUsdPorTanda,
          }),
          onDone: {
            target: "decidiendo",
            actions: [
              assign(({ context, event }) => ({
                resultado: event.output,
                costoUsd: context.costoUsd + event.output.costoUsd,
              })),
              ({ context }) => repositorio.quitar(context.worktree!),
            ],
          },
          // Si el interno falla (git, disco), la tanda cuenta como 0 conservados: sin mejora.
          onError: {
            target: "descartando",
            actions: [
              assign({ resultado: { conservados: 0, iteraciones: 0, costoUsd: 0 } }),
              ({ context }) => repositorio.quitar(context.worktree!),
            ],
          },
        },
      },
      decidiendo: {
        always: [{ guard: "superaMejor", target: "conservando" }, { target: "descartando" }],
      },
      conservando: {
        entry: [
          ({ context }) => {
            if (repositorio.tocados().includes(PROGRAMA)) {
              const n = context.resultado!.conservados;
              repositorio.confirmar(`program.md v${context.version}: mejora, ${n} conservados`, [PROGRAMA]);
            }
          },
          assign(({ context }) => ({
            mejorConservados: context.resultado!.conservados,
            ...anotar(context, "mejora"),
          })),
        ],
        always: "siguiente",
      },
      descartando: {
        entry: [
          () => repositorio.restaurar(PROGRAMA),
          assign(({ context }) => anotar(context, "sin_mejora")),
        ],
        always: "siguiente",
      },
      siguiente: {
        always: [{ guard: "quedanVersiones", target: "proponiendoPrograma" }, { target: "terminado" }],
      },
      proponiendoPrograma: {
        invoke: {
          src: "reescribirPrograma",
          onDone: {
            target: "custodiando",
            actions: assign(({ context, event }) => ({ costoUsd: context.costoUsd + event.output.costoUsd })),
          },
          onError: {
            target: "custodiando",
            actions: assign(({ context, event }) => ({ costoUsd: context.costoUsd + costoDe(event.error) })),
          },
        },
      },
      // Guardia: el meta-agente solo puede tocar program.md, y fuera del bloque protegido.
      custodiando: {
        entry: [
          () => {
            const otros = repositorio.tocados().filter((r) => r !== PROGRAMA);
            const protegidoIntacto =
              bloqueProtegido(repositorio.contenido(PROGRAMA)) === bloqueProtegido(repositorio.vigente(PROGRAMA));
            if (otros.length > 0 || !protegidoIntacto) repositorio.restaurar(".");
          },
          assign(({ context }) => ({ version: context.version + 1 })),
        ],
        always: "preparando",
      },
      terminado: { type: "final" },
    },
    output: ({ context }) => ({
      mejorConservados: context.mejorConservados,
      historial: context.historial,
      costoUsd: context.costoUsd,
    }),
  });
}
