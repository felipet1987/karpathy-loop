import { parseArgs } from "node:util";
import { CorridaCancelada, Rechazo, type Corridas } from "../../nucleo/corridas.ts";
import type { Features } from "../../nucleo/features.ts";
import { nombre, opcionesAprobar, opcionesExterna, opcionesInterna, UsoInvalido } from "./validacion.ts";

export const USO = `Uso:
  node src/main.ts interno [--iteraciones 10] [--minutos 15] [--tope-usd X] [--etiqueta X]
  node src/main.ts externo [--versiones 4] [--iteraciones 8] [--minutos 10] [--tope-usd X] [--etiqueta X]

  node src/main.ts feature checks <id> [--repo .]
  node src/main.ts feature aprobar <id> [--repo .] [--rondas 5] [--tope-usd X]
  node src/main.ts feature mejorar [--repo .]

  node src/main.ts servir [--puerto 8787] [--concurrencia 3]   API REST en 127.0.0.1 (ver README)

--tope-usd: gasto máximo por corrida (por tanda en externo); sin flag, sin tope.
--etiqueta: nombre del worktree y de la rama; por defecto, la fecha AAAAMMDDhhmm (UTC).
feature: <id> es un título "## <id>" de features.md. checks escribe los checks para revisar;
aprobar los commitea y corre las rondas; mejorar reescribe program.md con el registro de rondas.`;

/** Lo que la consola necesita para escribir: `console` lo cumple. */
export interface Terminal {
  log(texto: string): void;
  error(texto: string): void;
}

/** Flags que acepta cada comando; cualquier otro es uso inválido. */
const FLAGS: Record<string, readonly string[]> = {
  interno: ["iteraciones", "minutos", "tope-usd", "etiqueta"],
  externo: ["versiones", "iteraciones", "minutos", "tope-usd", "etiqueta"],
  "feature checks": ["repo"],
  "feature aprobar": ["repo", "rondas", "tope-usd"],
  "feature mejorar": ["repo"],
};

/**
 * Adaptador de entrada: traduce argumentos de línea de comandos a casos de uso de
 * `Corridas` y `Features`, y su resultado a texto y código de salida.
 */
export class Consola {
  readonly #corridas: Corridas;
  readonly #features: Features;
  readonly #terminal: Terminal;

  constructor(corridas: Corridas, features: Features, terminal: Terminal) {
    this.#corridas = corridas;
    this.#features = features;
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
      if (e instanceof Rechazo) {
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
          repo: { type: "string" },
          rondas: { type: "string" },
        },
      });
    } catch (e) {
      throw new UsoInvalido((e as Error).message);
    }
    const { positionals, values } = leidos;
    const comando = positionals[0] === "feature" ? `feature ${positionals[1] ?? ""}`.trim() : (positionals[0] ?? "");
    const permitidos = FLAGS[comando];
    if (!permitidos) throw new UsoInvalido(comando ? `Comando desconocido: ${comando}` : "Falta el comando.");
    const sobrantes = Object.keys(values).filter((f) => !permitidos.includes(f));
    if (sobrantes.length > 0) throw new UsoInvalido(`--${sobrantes[0]} no aplica a ${comando}.`);
    const repo = values.repo ?? ".";
    const valores = { ...values, topeUsd: values["tope-usd"] };

    if (comando.startsWith("feature")) {
      const resto = positionals.slice(2);
      if (comando === "feature mejorar") {
        if (resto.length !== 0) throw new UsoInvalido("feature mejorar no lleva <id>.");
        return this.#features.mejorar({ repo }, interrupcion);
      }
      if (resto.length !== 1) throw new UsoInvalido(`Falta el <id> de la feature (${comando} <id>).`);
      if (comando === "feature checks") return this.#features.checks({ repo, id: nombre("id", resto[0]) }, interrupcion);
      return this.#features.aprobar(opcionesAprobar(repo, resto[0], valores), aviso, interrupcion);
    }

    if (positionals.length !== 1) throw new UsoInvalido(`Argumento de más: ${positionals[1]}`);
    if (comando === "interno") return this.#corridas.interna(opcionesInterna(valores), aviso, interrupcion);
    return this.#corridas.externa(opcionesExterna(valores), aviso, interrupcion);
  }
}
