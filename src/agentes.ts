// Actores reales: entrenar con uv, y los dos agentes del Claude Agent SDK.
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fromPromise } from "xstate";
import { maquinaExterna } from "./externo.ts";
import { EDITABLE, maquinaInterna, type EntradaProponer, type Medicion, type Propuesta } from "./interno.ts";

const MODELO = process.env.KL_MODELO ?? "claude-opus-5-5";
const LIMITE_ENTRENAMIENTO_MS = 60_000; // 20 s de presupuesto + arranque; más que esto es crash

/** Corre `uv run train.py > run.log 2>&1` y lee val_loss del log. */
export const entrenar = fromPromise<Medicion, { dir: string }>(
  ({ input }) =>
    new Promise((resolve, reject) => {
      const log = createWriteStream(join(input.dir, "run.log"));
      const proc = spawn("uv", ["run", "train.py"], { cwd: input.dir });
      proc.stdout.pipe(log);
      proc.stderr.pipe(log);
      const reloj = setTimeout(() => proc.kill("SIGKILL"), LIMITE_ENTRENAMIENTO_MS);
      proc.on("close", (codigo) => {
        clearTimeout(reloj);
        log.end(() => {
          const m = readFileSync(join(input.dir, "run.log"), "utf8").match(/^val_loss:\s+(\S+)/m);
          const valLoss = m ? Number(m[1]) : NaN;
          if (codigo === 0 && Number.isFinite(valLoss)) resolve({ valLoss });
          else reject(new Error(`entrenamiento fallido (código ${codigo})`));
        });
      });
    }),
);

async function correrAgente(opciones: {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  herramientas: string[];
}): Promise<{ texto: string; costoUsd: number }> {
  let resultado: SDKResultMessage | undefined;
  for await (const mensaje of query({
    prompt: opciones.prompt,
    options: {
      systemPrompt: opciones.systemPrompt,
      cwd: opciones.cwd,
      tools: opciones.herramientas,
      allowedTools: opciones.herramientas,
      permissionMode: "dontAsk", // no hay nadie para aprobar: lo que no está permitido se niega
      settingSources: [], // sin hooks ni CLAUDE.md del usuario
      model: MODELO,
      maxTurns: 25,
      persistSession: false,
    },
  })) {
    if (mensaje.type === "result") resultado = mensaje;
  }
  if (!resultado) throw new Error("el agente terminó sin resultado");
  if (resultado.subtype !== "success") throw new Error(`${resultado.subtype}: ${resultado.errors.join("; ")}`);
  if (resultado.is_error) throw new Error(resultado.result);
  return { texto: resultado.result.trim(), costoUsd: resultado.total_cost_usd };
}

/** Investigador: hace UN cambio a train.py. Sin shell: entrenar y commitear es trabajo de la máquina. */
export const proponer = fromPromise<Propuesta, EntradaProponer>(async ({ input }) => {
  const tsv = join(input.dir, "results.tsv");
  const historial = existsSync(tsv) ? readFileSync(tsv, "utf8") : "(vacío)";
  const { texto, costoUsd } = await correrAgente({
    systemPrompt: readFileSync(input.rutaPrograma, "utf8"),
    prompt:
      `Historial de experimentos (results.tsv):\n\n${historial}\n\n` +
      `Haz UN cambio a ${EDITABLE} que creas que bajará val_loss. ` +
      `Responde solo con una línea que describa el cambio.`,
    cwd: input.dir,
    herramientas: ["Read", "Edit", "Glob", "Grep"],
  });
  return { descripcion: texto.split("\n").at(-1)!.slice(0, 200), costoUsd };
});

/** Meta-agente: reescribe program.md a partir de los resultados de las tandas. */
export const proponerPrograma = fromPromise<{ costoUsd: number }, { raiz: string }>(async ({ input }) => {
  const { costoUsd } = await correrAgente({
    systemPrompt: readFileSync(join(input.raiz, "meta-prompt.md"), "utf8"),
    prompt: "Lee meta/ y program.md, y haz UN cambio a program.md.",
    cwd: input.raiz,
    herramientas: ["Read", "Edit", "Glob", "Grep"],
  });
  return { costoUsd };
});

export const maquinaInternaReal = maquinaInterna.provide({ actors: { proponer, entrenar } });
export const maquinaExternaReal = maquinaExterna.provide({
  actors: { interno: maquinaInternaReal, proponerPrograma },
});
