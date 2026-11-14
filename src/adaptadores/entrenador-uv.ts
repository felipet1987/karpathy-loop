import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entrenador, Medicion } from "../nucleo/puertos.ts";
import { ProcesoEnGrupo } from "./proceso-en-grupo.ts";

/** Corre `uv run train.py`, deja stdout y stderr en run.log y lee val_loss. */
export class EntrenadorUv implements Entrenador {
  readonly #limiteMs: number;

  constructor(limiteMs: number) {
    this.#limiteMs = limiteMs;
  }

  async medicion(dir: string, signal: AbortSignal): Promise<Medicion> {
    const s = await new ProcesoEnGrupo("uv", ["run", "train.py"], dir, this.#limiteMs).salida("", signal);
    writeFileSync(join(dir, "run.log"), s.combinada);
    const m = s.combinada.match(/^val_loss:\s+(\S+)/m);
    const valLoss = m ? Number(m[1]) : NaN;
    if (s.motivo === "fin" && s.codigo === 0 && Number.isFinite(valLoss)) return { valLoss };
    throw new Error(`entrenamiento fallido (${s.motivo}, código ${s.codigo})`);
  }
}
