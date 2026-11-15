import { parseArgs } from "node:util";
import { CorridaCancelada, RepoConCambios, type Corridas } from "../../nucleo/corridas.ts";

export const USO = `Uso:
  node src/cli.ts interno [--iteraciones 10] [--minutos 15] [--tope-usd X] [--etiqueta X]
  node src/cli.ts externo [--versiones 4] [--iteraciones 8] [--minutos 10] [--tope-usd X] [--etiqueta X]

--tope-usd: gasto máximo por corrida interna (por tanda en externo); sin flag, sin tope.
--etiqueta: nombre del worktree y de la rama; por defecto, la fecha AAAAMMDDhhmm (UTC).`;

/** Lo que la consola necesita para escribir: `console` lo cumple. */
export interface Terminal {
  log(texto: string): void;
  error(texto: string): void;
}

class UsoInvalido extends Error {}

/**
 * Adaptador de entrada: traduce argumentos de línea de comandos a casos de uso de
 * `Corridas` y su resultado a texto y código de salida.
 */
export class Consola {
  readonly #corridas: Corridas;
  readonly #terminal: Terminal;

  constructor(corridas: Corridas, terminal: Terminal) {
    this.#corridas = corridas;
    this.#terminal = terminal;
  }

  /** Corre el comando y devuelve el código de salida del proceso. */
  async codigo(argumentos: readonly string[], interrupcion: AbortSignal): Promise<number> {
    const aviso = (estado: string) => this.#terminal.log(`[${new Date().toLocaleTimeString()}] ${estado}`);
    try {
      const salida = await this.#comando(argumentos, aviso, interrupcion);
      this.#terminal.log(JSON.stringify(salida, null, 2));
      return 0;
    } catch (e) {
      if (e instanceof UsoInvalido) {
        this.#terminal.error(`${e.message}\n\n${USO}`);
        return 2;
      }
      if (e instanceof RepoConCambios) {
        this.#terminal.error(e.message);
        return 1;
      }
      if (e instanceof CorridaCancelada) {
        this.#terminal.error(e.message);
        return 130;
      }
      throw e;
    }
  }

  #comando(argumentos: readonly string[], aviso: (estado: string) => void, interrupcion: AbortSignal) {
    let leidos;
    try {
      leidos = parseArgs({
        args: [...argumentos],
        allowPositionals: true,
        options: {
          iteraciones: { type: "string" },
          minutos: { type: "string" },
          versiones: { type: "string" },
          "tope-usd": { type: "string" },
          etiqueta: { type: "string" },
        },
      });
    } catch (e) {
      throw new UsoInvalido((e as Error).message);
    }
    const { positionals, values } = leidos;
    const etiqueta = values.etiqueta ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    if (!/^[\w.-]+$/.test(etiqueta)) throw new UsoInvalido(`--etiqueta inválida: ${etiqueta}`);
    const topeUsd = positivo("tope-usd", values["tope-usd"], Infinity);
    if (positionals.length !== 1) throw new UsoInvalido("Falta el comando (interno o externo).");
    if (positionals[0] === "interno") {
      if (values.versiones !== undefined) throw new UsoInvalido("--versiones solo aplica a externo.");
      return this.#corridas.interna(
        {
          etiqueta,
          iteraciones: entero("iteraciones", values.iteraciones, 10),
          minutos: positivo("minutos", values.minutos, 15),
          topeUsd,
        },
        aviso,
        interrupcion,
      );
    }
    if (positionals[0] === "externo") {
      return this.#corridas.externa(
        {
          etiqueta,
          versiones: entero("versiones", values.versiones, 4),
          iteracionesPorTanda: entero("iteraciones", values.iteraciones, 8),
          minutosPorTanda: positivo("minutos", values.minutos, 10),
          topeUsdPorTanda: topeUsd,
        },
        aviso,
        interrupcion,
      );
    }
    throw new UsoInvalido(`Comando desconocido: ${positionals[0]}`);
  }
}

function positivo(nombre: string, valor: string | undefined, porDefecto: number): number {
  if (valor === undefined) return porDefecto;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) throw new UsoInvalido(`--${nombre} tiene que ser un número mayor que 0: ${valor}`);
  return n;
}

function entero(nombre: string, valor: string | undefined, porDefecto: number): number {
  const n = positivo(nombre, valor, porDefecto);
  if (!Number.isInteger(n)) throw new UsoInvalido(`--${nombre} tiene que ser entero: ${valor}`);
  return n;
}
