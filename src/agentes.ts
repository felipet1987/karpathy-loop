// Actores reales: entrenar y correr checks con uv, y los agentes con Claude Code (`claude -p`).
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fromPromise } from "xstate";
import { maquinaExterna } from "./externo.ts";
import {
  CHECKS,
  EDITABLE,
  maquinaInterna,
  type EntradaConstruir,
  type EntradaEscribirChecks,
  type Medicion,
  type Propuesta,
  type ResultadoChecks,
} from "./interno.ts";

const ejecutar = promisify(execFile);

const MODELO = process.env.KL_MODELO ?? "claude-opus-5-5";
const PRESUPUESTO_AGENTE_USD = Number(process.env.KL_PRESUPUESTO_AGENTE_USD ?? 2); // por invocación
const LIMITE_AGENTE_MS = 15 * 60_000;
const LIMITE_ENTRENAMIENTO_MS = 60_000; // 20 s de presupuesto + arranque; más que esto es crash
const LIMITE_CHECK_MS = 60_000;
const MAX_SALIDA = 4_000; // caracteres de salida de checks que vuelven al agente

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

/** Corre cada `checks/*.py` con `uv run python`; pasan si todos salen con 0. */
export const correrChecks = fromPromise<ResultadoChecks, { dir: string }>(async ({ input }) => {
  const carpeta = join(input.dir, CHECKS);
  const archivos = existsSync(carpeta) ? readdirSync(carpeta).filter((a) => a.endsWith(".py")).sort() : [];
  if (archivos.length === 0) return { ok: false, salida: `no hay checks en ${CHECKS}` };
  const salidas: string[] = [];
  let ok = true;
  for (const archivo of archivos) {
    const ruta = join(CHECKS, archivo);
    try {
      const { stdout, stderr } = await ejecutar("uv", ["run", "python", ruta], {
        cwd: input.dir,
        timeout: LIMITE_CHECK_MS,
      });
      salidas.push(`PASA ${ruta}\n${stdout}${stderr}`);
    } catch (e) {
      ok = false;
      const { stdout = "", stderr = "", code, killed } = e as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
      salidas.push(`FALLA ${ruta} (${killed ? "timeout" : `código ${code}`})\n${stdout}${stderr}`);
    }
  }
  return { ok, salida: salidas.join("\n").slice(-MAX_SALIDA) };
});

/** Una invocación headless de Claude Code; el prompt va por stdin. */
async function correrClaude(opciones: {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  herramientas: string[];
}): Promise<{ texto: string; costoUsd: number }> {
  const herramientas = opciones.herramientas.join(",");
  const proceso = ejecutar(
    "claude",
    [
      "-p",
      "--output-format", "json",
      "--system-prompt", opciones.systemPrompt,
      "--tools", herramientas,
      "--allowedTools", herramientas,
      "--permission-mode", "dontAsk", // no hay nadie para aprobar: lo que no está permitido se niega
      "--setting-sources", "", // sin hooks ni CLAUDE.md del usuario
      "--no-session-persistence",
      "--model", MODELO,
      "--max-budget-usd", String(PRESUPUESTO_AGENTE_USD),
    ],
    { cwd: opciones.cwd, timeout: LIMITE_AGENTE_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  proceso.child.stdin!.end(opciones.prompt);
  const { stdout } = await proceso;
  const r = JSON.parse(stdout) as { subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number };
  if (r.is_error || r.subtype !== "success") throw new Error(`${r.subtype}: ${r.result ?? ""}`);
  return { texto: (r.result ?? "").trim(), costoUsd: r.total_cost_usd ?? 0 };
}

const ultimaLinea = (texto: string) => (texto.split("\n").at(-1) ?? "").slice(0, 200);

/** Fase 1 (write checks): decide el experimento y escribe en checks/ lo que el cambio debe cumplir. */
export const escribirChecks = fromPromise<Propuesta, EntradaEscribirChecks>(async ({ input }) => {
  const tsv = join(input.dir, "results.tsv");
  const historial = existsSync(tsv) ? readFileSync(tsv, "utf8") : "(vacío)";
  const { texto, costoUsd } = await correrClaude({
    systemPrompt: readFileSync(input.rutaPrograma, "utf8"),
    prompt:
      `Historial de experimentos (results.tsv):\n\n${historial}\n\n` +
      `Fase 1 de 3 (write checks). Decide UN cambio a ${EDITABLE} que creas que bajará val_loss, ` +
      `pero NO edites ${EDITABLE} todavía: escribe o ajusta checks en ${CHECKS} que verifiquen ` +
      `que el cambio quedó bien hecho. Responde solo con una línea que describa el cambio.`,
    cwd: input.dir,
    herramientas: ["Read", "Write", "Edit", "Glob", "Grep"],
  });
  return { descripcion: ultimaLinea(texto), costoUsd };
});

/** Fase 2 (build): implementa el cambio en train.py hasta que pasen los checks. */
export const construir = fromPromise<{ costoUsd: number }, EntradaConstruir>(async ({ input }) => {
  const fallo = input.fallo
    ? `\n\nEl intento anterior no pasó los checks. Salida:\n\n${input.fallo}\n\nCorrige ${EDITABLE}.`
    : "";
  const { costoUsd } = await correrClaude({
    systemPrompt: readFileSync(input.rutaPrograma, "utf8"),
    prompt:
      `Fase 2 de 3 (build). Implementa en ${EDITABLE}: ${input.descripcion}\n` +
      `Los checks de ${CHECKS} tienen que pasar; no los modifiques.${fallo}`,
    cwd: input.dir,
    herramientas: ["Read", "Edit", "Glob", "Grep"],
  });
  return { costoUsd };
});

/** Meta-agente: reescribe program.md a partir de los resultados de las tandas. */
export const proponerPrograma = fromPromise<{ costoUsd: number }, { raiz: string }>(async ({ input }) => {
  const { costoUsd } = await correrClaude({
    systemPrompt: readFileSync(join(input.raiz, "meta-prompt.md"), "utf8"),
    prompt: "Lee meta/ y program.md, y haz UN cambio a program.md.",
    cwd: input.raiz,
    herramientas: ["Read", "Edit", "Glob", "Grep"],
  });
  return { costoUsd };
});

export const maquinaInternaReal = maquinaInterna.provide({
  actors: { escribirChecks, construir, correrChecks, entrenar },
});
export const maquinaExternaReal = maquinaExterna.provide({
  actors: { interno: maquinaInternaReal, proponerPrograma },
});
