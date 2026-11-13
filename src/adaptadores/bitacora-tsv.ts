import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Bitacora } from "../nucleo/puertos.ts";

/** Bitácora en un archivo TSV; el archivo y su carpeta se crean con la primera fila. */
export class BitacoraTsv implements Bitacora {
  readonly #ruta: string;
  readonly #encabezado: readonly string[];

  constructor(ruta: string, encabezado: readonly string[]) {
    this.#ruta = ruta;
    this.#encabezado = encabezado;
  }

  anotar(campos: readonly string[]): void {
    if (!existsSync(this.#ruta)) {
      mkdirSync(dirname(this.#ruta), { recursive: true });
      writeFileSync(this.#ruta, `${this.#encabezado.join("\t")}\n`);
    }
    appendFileSync(this.#ruta, `${campos.map((c) => c.replace(/[\t\n]+/g, " ")).join("\t")}\n`);
  }

  texto(): string {
    return existsSync(this.#ruta) ? readFileSync(this.#ruta, "utf8") : "";
  }
}
