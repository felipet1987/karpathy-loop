import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entrenador, Medicion } from "../nucleo/puertos.ts";

/** Corre `uv run train.py > run.log 2>&1` y lee val_loss del log. */
export class EntrenadorUv implements Entrenador {
  readonly #limiteMs: number;

  constructor(limiteMs: number) {
    this.#limiteMs = limiteMs;
  }

  medicion(dir: string): Promise<Medicion> {
    return new Promise((resolve, reject) => {
      const ruta = join(dir, "run.log");
      const log = createWriteStream(ruta);
      const proc = spawn("uv", ["run", "train.py"], { cwd: dir });
      proc.stdout.pipe(log);
      proc.stderr.pipe(log);
      const reloj = setTimeout(() => proc.kill("SIGKILL"), this.#limiteMs);
      proc.on("close", (codigo) => {
        clearTimeout(reloj);
        log.end(() => {
          const m = readFileSync(ruta, "utf8").match(/^val_loss:\s+(\S+)/m);
          const valLoss = m ? Number(m[1]) : NaN;
          if (codigo === 0 && Number.isFinite(valLoss)) resolve({ valLoss });
          else reject(new Error(`entrenamiento fallido (código ${codigo})`));
        });
      });
    });
  }
}
