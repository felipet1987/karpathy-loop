import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHECKS } from "../nucleo/encargos.ts";
import type { Checks, ResultadoChecks } from "../nucleo/puertos.ts";

const ejecutar = promisify(execFile);

/** Corre cada `checks/*.py` con `uv run python`; pasan si todos salen con 0. */
export class ChecksUv implements Checks {
  readonly #limiteMs: number;

  constructor(limiteMs: number) {
    this.#limiteMs = limiteMs;
  }

  async resultado(dir: string): Promise<ResultadoChecks> {
    const carpeta = join(dir, CHECKS);
    const archivos = existsSync(carpeta) ? readdirSync(carpeta).filter((a) => a.endsWith(".py")).sort() : [];
    if (archivos.length === 0) return { ok: false, salida: `no hay checks en ${CHECKS}` };
    const salidas: string[] = [];
    let ok = true;
    for (const archivo of archivos) {
      const ruta = join(CHECKS, archivo);
      try {
        const { stdout, stderr } = await ejecutar("uv", ["run", "python", ruta], { cwd: dir, timeout: this.#limiteMs });
        salidas.push(`PASA ${ruta}\n${stdout}${stderr}`);
      } catch (e) {
        ok = false;
        const { stdout = "", stderr = "", code, killed } = e as {
          stdout?: string;
          stderr?: string;
          code?: unknown;
          killed?: boolean;
        };
        salidas.push(`FALLA ${ruta} (${killed ? "timeout" : `código ${code}`})\n${stdout}${stderr}`);
      }
    }
    return { ok, salida: salidas.join("\n") };
  }
}
