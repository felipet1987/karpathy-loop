import type { Checks, ResultadoChecks } from "../nucleo/puertos.ts";

/** Decorador: deja solo los últimos `max` caracteres de la salida, que es lo que vuelve al agente. */
export class SalidaRecortada implements Checks {
  readonly #origen: Checks;
  readonly #max: number;

  constructor(origen: Checks, max: number) {
    this.#origen = origen;
    this.#max = max;
  }

  async resultado(dir: string): Promise<ResultadoChecks> {
    const r = await this.#origen.resultado(dir);
    return { ok: r.ok, salida: r.salida.slice(-this.#max) };
  }
}
