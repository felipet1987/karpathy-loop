// Composition root: único lugar donde se construyen los adaptadores y se cablean al núcleo.
// La interfaz de línea de comandos vive en src/adaptadores/entrada/consola.ts (`--help` no
// existe: sin argumentos imprime el uso).
// Cada iteración llama a Claude Code (`claude -p`) al menos dos veces y consume cuota.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { BitacoraTsv } from "./adaptadores/bitacora-tsv.ts";
import { ChecksUv } from "./adaptadores/checks-uv.ts";
import { ClaudeCli } from "./adaptadores/claude-cli.ts";
import { Consola } from "./adaptadores/entrada/consola.ts";
import { EntrenadorUv } from "./adaptadores/entrenador-uv.ts";
import { RepositorioGit } from "./adaptadores/repositorio-git.ts";
import { SalidaRecortada } from "./adaptadores/salida-recortada.ts";
import { crearCorridas } from "./nucleo/corridas.ts";
import { ENCABEZADO_HISTORIAL } from "./nucleo/externo.ts";
import { ENCABEZADO_RESULTADOS } from "./nucleo/interno.ts";

const raiz = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const meta = join(raiz, "meta");

const corridas = crearCorridas({
  agente: new ClaudeCli(
    "claude",
    process.env.KL_MODELO ?? "claude-opus-5-5",
    Number(process.env.KL_PRESUPUESTO_AGENTE_USD ?? 2), // por invocación
    15 * 60_000,
  ),
  checks: new SalidaRecortada(new ChecksUv(60_000), 4_000), // lo recortado vuelve al agente
  entrenador: new EntrenadorUv(60_000), // 20 s de presupuesto + arranque; más que esto es crash
  repositorio: new RepositorioGit(raiz),
  bitacoraDeCorrida: (worktree) =>
    new BitacoraTsv(join(worktree.directorio(), "results.tsv"), ENCABEZADO_RESULTADOS),
  historial: new BitacoraTsv(join(meta, "historial.tsv"), ENCABEZADO_HISTORIAL),
  resultados: (v) => new BitacoraTsv(join(meta, `resultados-v${v}.tsv`), ENCABEZADO_RESULTADOS),
});

// Los agentes y el entrenamiento corren en su propio grupo de procesos, así que Ctrl-C no
// les llega: la señal aborta la corrida y cada adaptador mata su grupo.
const corte = new AbortController();
process.once("SIGINT", () => corte.abort());
process.once("SIGTERM", () => corte.abort());

process.exitCode = await new Consola(corridas, console).codigo(process.argv.slice(2), corte.signal);
