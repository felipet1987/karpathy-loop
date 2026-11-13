// Loop externo: optimiza program.md corriendo el loop interno por tandas.
//
//   preparando → corriendoInterno → decidiendo → conservando | descartando → siguiente
//        ↑                                                                    │
//        └──── custodiando ← proponiendoPrograma ←──── (¿quedan versiones?) ───┘
import { copyFileSync, existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assign, fromPromise, setup } from "xstate";
import { cambiados, crearWorktree, git } from "./git.ts";
import { maquinaInterna, type SalidaInterno } from "./interno.ts";

export interface EntradaExterno {
  raiz: string; // repo con program.md, prepare.py y train.py
  base: string; // commit del que parte cada tanda (todas parten del mismo)
  prefijo: string; // etiqueta de la corrida; cada tanda es <prefijo>-v<n>
  versiones: number;
  iteracionesPorTanda: number;
  minutosPorTanda: number;
}

export interface SalidaExterno {
  mejorGanancia: number;
  historial: { version: number; ganancia: number; estado: "conservar" | "descartar" }[];
  costoUsd: number;
}

interface Contexto extends EntradaExterno {
  version: number;
  dir: string;
  resultado: SalidaInterno | null;
  mejorGanancia: number;
  historial: SalidaExterno["historial"];
  costoUsd: number;
}

const PROTEGIDO = /<!-- protegido -->[\s\S]*?<!-- fin protegido -->/;
export const bloqueProtegido = (texto: string) => texto.match(PROTEGIDO)?.[0] ?? null;

const ganancia = (r: SalidaInterno) => (Number.isFinite(r.lineaBase - r.mejor) ? r.lineaBase - r.mejor : 0);

function anotarHistorial(raiz: string, version: number, g: number, estado: string) {
  const ruta = join(raiz, "meta", "historial.tsv");
  if (!existsSync(ruta)) writeFileSync(ruta, "version\tganancia\testado\n");
  appendFileSync(ruta, `v${version}\t${g.toFixed(6)}\t${estado}\n`);
}

export const maquinaExterna = setup({
  types: {
    input: {} as EntradaExterno,
    context: {} as Contexto,
    output: {} as SalidaExterno,
  },
  actors: {
    interno: maquinaInterna,
    // Se reemplaza con .provide(): agentes.ts trae el real y los tests uno falso.
    proponerPrograma: fromPromise<{ costoUsd: number }, { raiz: string }>(async () => {
      throw new Error("falta el actor proponerPrograma");
    }),
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
    dir: "",
    resultado: null,
    mejorGanancia: 0,
    historial: [],
    costoUsd: 0,
  }),
  initial: "preparando",
  states: {
    preparando: {
      entry: assign(({ context }) => {
        mkdirSync(join(context.raiz, "meta"), { recursive: true });
        return { dir: crearWorktree(context.raiz, `${context.prefijo}-v${context.version}`, context.base) };
      }),
      always: "corriendoInterno",
    },
    corriendoInterno: {
      invoke: {
        src: "interno",
        input: ({ context }) => ({
          dir: context.dir,
          rutaPrograma: join(context.raiz, "program.md"),
          maxIteraciones: context.iteracionesPorTanda,
          minutos: context.minutosPorTanda,
        }),
        onDone: {
          target: "decidiendo",
          actions: [
            assign(({ context, event }) => ({
              resultado: event.output,
              costoUsd: context.costoUsd + event.output.costoUsd,
            })),
            ({ context }) => {
              const tsv = join(context.dir, "results.tsv");
              if (existsSync(tsv)) copyFileSync(tsv, join(context.raiz, "meta", `resultados-v${context.version}.tsv`));
              git(context.raiz, "worktree", "remove", "--force", context.dir);
            },
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
          const g = ganancia(context.resultado!);
          if (cambiados(context.raiz).includes("program.md")) {
            git(context.raiz, "commit", "-qm", `program.md v${context.version}: ganancia ${g.toFixed(6)}`, "--", "program.md");
          }
          anotarHistorial(context.raiz, context.version, g, "conservar");
        },
        assign(({ context }) => {
          const g = ganancia(context.resultado!);
          return {
            mejorGanancia: g,
            historial: [...context.historial, { version: context.version, ganancia: g, estado: "conservar" as const }],
          };
        }),
      ],
      always: "siguiente",
    },
    descartando: {
      entry: [
        ({ context }) => {
          git(context.raiz, "checkout", "-q", "HEAD", "--", "program.md");
          anotarHistorial(context.raiz, context.version, ganancia(context.resultado!), "descartar");
        },
        assign(({ context }) => ({
          historial: [
            ...context.historial,
            { version: context.version, ganancia: ganancia(context.resultado!), estado: "descartar" as const },
          ],
        })),
      ],
      always: "siguiente",
    },
    siguiente: {
      always: [{ guard: "quedanVersiones", target: "proponiendoPrograma" }, { target: "terminado" }],
    },
    proponiendoPrograma: {
      invoke: {
        src: "proponerPrograma",
        input: ({ context }) => ({ raiz: context.raiz }),
        onDone: {
          target: "custodiando",
          actions: assign(({ context, event }) => ({ costoUsd: context.costoUsd + event.output.costoUsd })),
        },
        onError: { target: "custodiando" },
      },
    },
    // Guardia: el meta-agente solo puede tocar program.md, y fuera del bloque protegido.
    custodiando: {
      entry: [
        ({ context }) => {
          const programa = readFileSync(join(context.raiz, "program.md"), "utf8");
          const vigente = git(context.raiz, "show", "HEAD:program.md");
          const otros = cambiados(context.raiz).filter((r) => r !== "program.md");
          if (otros.length > 0 || bloqueProtegido(programa) !== bloqueProtegido(vigente)) {
            git(context.raiz, "checkout", "-q", "HEAD", "--", ".");
          }
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
