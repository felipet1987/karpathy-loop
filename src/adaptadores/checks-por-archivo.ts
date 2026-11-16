import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { Evaluador, Puntaje } from "../nucleo/puertos.ts";
import { ProcesoEnGrupo } from "./proceso-en-grupo.ts";

/** Intérprete por extensión; los archivos con otra extensión (p. ej. README.md) no son checks. */
const INTERPRETES: Record<string, (dir: string) => string[]> = {
  ".py": (dir) => (existsSync(join(dir, "pyproject.toml")) ? ["uv", "run", "python"] : ["python3"]),
  ".sh": () => ["bash"],
  ".js": () => ["node"],
  ".mjs": () => ["node"],
  ".ts": () => ["node"],
};

/**
 * Cada archivo de la carpeta es un check: pasa si sale con 0. El puntaje es cuántos pasan.
 * Cada check corre en su propio grupo de procesos, con plazo y cancelable.
 */
export class ChecksPorArchivo implements Evaluador {
  readonly #limiteMs: number;
  readonly #maxSalida: number;

  constructor(limiteMs: number, maxSalida: number) {
    this.#limiteMs = limiteMs;
    this.#maxSalida = maxSalida;
  }

  async puntaje(dir: string, carpeta: string, signal: AbortSignal): Promise<Puntaje> {
    const ruta = join(dir, carpeta);
    const archivos = existsSync(ruta)
      ? readdirSync(ruta)
          .filter((a) => extname(a) in INTERPRETES)
          .sort()
      : [];
    const fallidos: string[] = [];
    const salidas: string[] = [];
    for (const archivo of archivos) {
      const [comando, ...args] = INTERPRETES[extname(archivo)](dir);
      const s = await new ProcesoEnGrupo(comando, [...args, join(carpeta, archivo)], dir, this.#limiteMs).salida(
        "",
        signal,
      );
      if (s.motivo === "cancelado") throw new Error("checks cancelados");
      if (s.codigo !== 0) {
        fallidos.push(archivo);
        const motivo = s.motivo === "plazo" ? "plazo vencido" : `código ${s.codigo}`;
        salidas.push(`FALLA ${archivo} (${motivo})\n${s.combinada.slice(-this.#maxSalida)}`);
      }
    }
    const salida = archivos.length === 0 ? `no hay checks en ${carpeta}` : salidas.join("\n");
    return { pasados: archivos.length - fallidos.length, total: archivos.length, fallidos, salida };
  }
}
