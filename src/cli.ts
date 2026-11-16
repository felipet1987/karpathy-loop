// Composition root: único lugar donde se construyen los adaptadores y se cablean al núcleo.
// La interfaz de línea de comandos vive en src/adaptadores/entrada/consola.ts (`--help` no
// existe: sin argumentos imprime el uso).
// Cada iteración llama a Claude Code (`claude -p`) al menos dos veces y consume cuota.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BitacoraTsv } from "./adaptadores/bitacora-tsv.ts";
import { ChecksPorArchivo } from "./adaptadores/checks-por-archivo.ts";
import { ChecksUv } from "./adaptadores/checks-uv.ts";
import { ClaudeCli } from "./adaptadores/claude-cli.ts";
import { Consola } from "./adaptadores/entrada/consola.ts";
import { EntrenadorUv } from "./adaptadores/entrenador-uv.ts";
import { RepositorioGit } from "./adaptadores/repositorio-git.ts";
import { SalidaRecortada } from "./adaptadores/salida-recortada.ts";
import { crearCorridas } from "./nucleo/corridas.ts";
import { ENCABEZADO_HISTORIAL } from "./nucleo/externo.ts";
import { ENCABEZADO_RONDAS } from "./nucleo/feature.ts";
import { crearFeatures } from "./nucleo/features.ts";
import { ENCABEZADO_RESULTADOS } from "./nucleo/interno.ts";

const toplevel = (ruta: string) =>
  execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ruta, encoding: "utf8" }).trim();
const raiz = toplevel(".");
const meta = join(raiz, "meta");

// Skills write-checks, feature-builder y auto-loop (plugin `kl`), cargadas solo en cada `claude -p`.
const plugin = fileURLToPath(new URL("../plugin", import.meta.url));

const agente = new ClaudeCli(
  "claude",
  process.env.KL_MODELO ?? "claude-opus-5-5",
  Number(process.env.KL_PRESUPUESTO_AGENTE_USD ?? 2), // por invocación
  15 * 60_000,
  [plugin],
);

const corridas = crearCorridas({
  agente,
  checks: new SalidaRecortada(new ChecksUv(60_000), 4_000), // lo recortado vuelve al agente
  entrenador: new EntrenadorUv(60_000), // 20 s de presupuesto + arranque; más que esto es crash
  repositorio: new RepositorioGit(raiz),
  bitacoraDeCorrida: (worktree) =>
    new BitacoraTsv(join(worktree.directorio(), "results.tsv"), ENCABEZADO_RESULTADOS),
  historial: new BitacoraTsv(join(meta, "historial.tsv"), ENCABEZADO_HISTORIAL),
  resultados: (v) => new BitacoraTsv(join(meta, `resultados-v${v}.tsv`), ENCABEZADO_RESULTADOS),
});

// Flujo por feature sobre cualquier repo (--repo). Registro de rondas y reportes en <repo>/.kl/.
const features = crearFeatures({
  agente,
  evaluador: new ChecksPorArchivo(5 * 60_000, 2_000),
  repositorio: (ruta) => new RepositorioGit(toplevel(ruta)),
  rondas: (repo, id) => new BitacoraTsv(join(repo.directorio(), ".kl", "rondas", `${id}.tsv`), ENCABEZADO_RONDAS),
  reporte: (repo, id, texto) => {
    const ruta = join(repo.directorio(), ".kl", "reportes", `${id}.md`);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, texto);
    return ruta;
  },
});

// Los agentes y el entrenamiento corren en su propio grupo de procesos, así que Ctrl-C no
// les llega: la señal aborta la corrida y cada adaptador mata su grupo.
const corte = new AbortController();
process.once("SIGINT", () => corte.abort());
process.once("SIGTERM", () => corte.abort());

process.exitCode = await new Consola(corridas, features, console).codigo(process.argv.slice(2), corte.signal);
