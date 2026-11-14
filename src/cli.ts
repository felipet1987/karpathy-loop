// Uso:
//   node src/cli.ts interno [--iteraciones 10] [--minutos 15] [--tope-usd 5] [--etiqueta nov13]
//   node src/cli.ts externo [--versiones 4] [--iteraciones 8] [--minutos 10] [--tope-usd 5] [--etiqueta nov13]
// --tope-usd: gasto máximo por corrida interna (por tanda en externo); sin flag, sin tope.
// Cada iteración llama a Claude Code (`claude -p`) al menos dos veces y consume cuota.
// Composition root: único lugar donde se construyen los adaptadores y se cablean al núcleo.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createActor, type AnyActorLogic } from "xstate";
import { BitacoraTsv } from "./adaptadores/bitacora-tsv.ts";
import { ChecksUv } from "./adaptadores/checks-uv.ts";
import { ClaudeCli } from "./adaptadores/claude-cli.ts";
import { EntrenadorUv } from "./adaptadores/entrenador-uv.ts";
import { RepositorioGit } from "./adaptadores/repositorio-git.ts";
import { SalidaRecortada } from "./adaptadores/salida-recortada.ts";
import { crearMaquinaExterna, ENCABEZADO_HISTORIAL } from "./nucleo/externo.ts";
import { crearMaquinaInterna, ENCABEZADO_RESULTADOS } from "./nucleo/interno.ts";

const raiz = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const repositorio = new RepositorioGit(raiz);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    iteraciones: { type: "string" },
    minutos: { type: "string" },
    versiones: { type: "string" },
    "tope-usd": { type: "string" },
    etiqueta: { type: "string", default: new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "") },
  },
});

if (repositorio.tocados().length > 0) {
  console.error("El repo tiene cambios sin commitear; las máquinas hacen checkout y los perderían.");
  process.exit(1);
}

async function correr(logica: AnyActorLogic, input: unknown) {
  const actor = createActor(logica, { input });
  let anterior = "";
  actor.subscribe((s) => {
    const estado = JSON.stringify(s.value);
    if (estado !== anterior) console.log(`[${new Date().toLocaleTimeString()}] ${estado}`);
    anterior = estado;
  });
  // Los agentes y el entrenamiento corren en su propio grupo de procesos, así que Ctrl-C no
  // les llega: detener el actor aborta sus signals y cada adaptador mata su grupo.
  const detener = () => {
    console.error("Deteniendo: se cancelan los procesos en curso.");
    actor.stop();
    process.exitCode = 130;
  };
  process.once("SIGINT", detener);
  process.once("SIGTERM", detener);
  actor.start();
  const fin = await new Promise((resolve, reject) => {
    actor.subscribe({ complete: () => resolve(actor.getSnapshot().output), error: reject });
  });
  if (fin !== undefined) console.log(JSON.stringify(fin, null, 2)); // undefined: se detuvo
}

const base = repositorio.commitCorto();
const topeUsd = values["tope-usd"] === undefined ? Infinity : Number(values["tope-usd"]);
const puertos = {
  agente: new ClaudeCli(
    "claude",
    process.env.KL_MODELO ?? "claude-opus-5-5",
    Number(process.env.KL_PRESUPUESTO_AGENTE_USD ?? 2), // por invocación
    15 * 60_000,
  ),
  checks: new SalidaRecortada(new ChecksUv(60_000), 4_000), // lo recortado vuelve al agente
  entrenador: new EntrenadorUv(60_000), // 20 s de presupuesto + arranque; más que esto es crash
};
if (positionals[0] === "interno") {
  const worktree = repositorio.worktree(values.etiqueta, base);
  await correr(crearMaquinaInterna(puertos), {
    repositorio: worktree,
    bitacora: new BitacoraTsv(join(worktree.directorio(), "results.tsv"), ENCABEZADO_RESULTADOS),
    programa: repositorio.contenido("program.md"),
    maxIteraciones: Number(values.iteraciones ?? 10),
    minutos: Number(values.minutos ?? 15),
    topeUsd,
  });
} else if (positionals[0] === "externo") {
  const meta = join(raiz, "meta");
  const maquina = crearMaquinaExterna({
    ...puertos,
    repositorio,
    historial: new BitacoraTsv(join(meta, "historial.tsv"), ENCABEZADO_HISTORIAL),
    resultados: (v) => new BitacoraTsv(join(meta, `resultados-v${v}.tsv`), ENCABEZADO_RESULTADOS),
  });
  await correr(maquina, {
    base,
    prefijo: values.etiqueta,
    versiones: Number(values.versiones ?? 4),
    iteracionesPorTanda: Number(values.iteraciones ?? 8),
    minutosPorTanda: Number(values.minutos ?? 10),
    topeUsdPorTanda: topeUsd,
  });
} else {
  console.error("Uso: node src/cli.ts interno|externo [--iteraciones N] [--minutos N] [--versiones N] [--tope-usd X] [--etiqueta X]");
  process.exit(2);
}
