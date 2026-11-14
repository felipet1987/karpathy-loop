// Loop externo: optimiza program.md corriendo el loop interno por tandas.
//
//   preparando → corriendoInterno → decidiendo → conservando | descartando → siguiente
//        ↑                                                                    │
//        └──── custodiando ← proponiendoPrograma ←──── (¿quedan versiones?) ───┘
import { assign, fromPromise, setup } from "xstate";
import { encargoPrograma } from "./encargos.ts";
import { crearMaquinaInterna, type PuertosInterno, type SalidaInterno } from "./interno.ts";
import { costoDe, type Bitacora, type Repositorio, type Respuesta } from "./puertos.ts";

export interface PuertosExterno extends PuertosInterno {
  repositorio: Repositorio; // raíz: program.md, meta-prompt.md, prepare.py y train.py
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

export interface SalidaExterno {
  mejorGanancia: number;
  historial: { version: number; ganancia: number; estado: "conservar" | "descartar" }[];
  costoUsd: number;
}

export const ENCABEZADO_HISTORIAL = ["version", "ganancia", "estado"] as const;

const PROGRAMA = "program.md";

interface Contexto extends EntradaExterno {
  version: number;
  worktree: Repositorio | null;
  resultado: SalidaInterno | null;
  mejorGanancia: number;
  historial: SalidaExterno["historial"];
  costoUsd: number;
}

const PROTEGIDO = /<!-- protegido -->[\s\S]*?<!-- fin protegido -->/;
export const bloqueProtegido = (texto: string) => texto.match(PROTEGIDO)?.[0] ?? null;

const ganancia = (r: SalidaInterno) => (Number.isFinite(r.lineaBase - r.mejor) ? r.lineaBase - r.mejor : 0);

export function crearMaquinaExterna(puertos: PuertosExterno) {
  const { repositorio } = puertos;
  const anotar = (c: Contexto, estado: "conservar" | "descartar") => {
    const g = ganancia(c.resultado!);
    puertos.historial.anotar([`v${c.version}`, g.toFixed(6), estado]);
    return { historial: [...c.historial, { version: c.version, ganancia: g, estado }] };
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
      reescribirPrograma: fromPromise<Respuesta>(async () =>
        puertos.agente.respuesta(encargoPrograma(repositorio.directorio(), repositorio.contenido("meta-prompt.md"))),
      ),
    },
    guards: {
      superaMejor: ({ context }) => ganancia(context.resultado!) > context.mejorGanancia,
      quedanVersiones: ({ context }) => context.version < context.versiones,
    },
  }).createMachine({
    id: "externo",
    context: ({ input }) => ({
      ...input,
      version: 1,
      worktree: null,
      resultado: null,
      mejorGanancia: 0,
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
          // Si el interno falla (git, disco), la tanda cuenta como ganancia 0 y se descarta.
          onError: {
            target: "descartando",
            actions: [
              assign({ resultado: { lineaBase: Infinity, mejor: Infinity, iteraciones: 0, costoUsd: 0 } }),
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
              const g = ganancia(context.resultado!).toFixed(6);
              repositorio.confirmar(`program.md v${context.version}: ganancia ${g}`, [PROGRAMA]);
            }
          },
          assign(({ context }) => ({ mejorGanancia: ganancia(context.resultado!), ...anotar(context, "conservar") })),
        ],
        always: "siguiente",
      },
      descartando: {
        entry: [
          () => repositorio.restaurar(PROGRAMA),
          assign(({ context }) => anotar(context, "descartar")),
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
      mejorGanancia: context.mejorGanancia,
      historial: context.historial,
      costoUsd: context.costoUsd,
    }),
  });
}
