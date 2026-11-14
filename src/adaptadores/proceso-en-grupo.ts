import { spawn } from "node:child_process";

export interface Salida {
  codigo: number; // -1 si terminó por señal
  stdout: string;
  combinada: string; // stdout y stderr en orden de llegada
  motivo: "fin" | "plazo" | "cancelado";
}

/**
 * Proceso hijo en su propio grupo. Al vencer el plazo o abortarse el signal se mata el
 * grupo entero: el hijo y sus nietos (p. ej. `uv` y el `python` que lanza).
 */
export class ProcesoEnGrupo {
  readonly #comando: string;
  readonly #args: readonly string[];
  readonly #cwd: string;
  readonly #limiteMs: number;

  constructor(comando: string, args: readonly string[], cwd: string, limiteMs: number) {
    this.#comando = comando;
    this.#args = args;
    this.#cwd = cwd;
    this.#limiteMs = limiteMs;
  }

  salida(entrada: string, signal: AbortSignal): Promise<Salida> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.#comando, this.#args, { cwd: this.#cwd, detached: true });
      let stdout = "";
      let combinada = "";
      let motivo: Salida["motivo"] = "fin";
      proc.stdout.setEncoding("utf8").on("data", (d: string) => {
        stdout += d;
        combinada += d;
      });
      proc.stderr.setEncoding("utf8").on("data", (d: string) => {
        combinada += d;
      });
      const matar = (por: Salida["motivo"]) => () => {
        motivo = por;
        try {
          process.kill(-proc.pid!, "SIGKILL"); // pid negativo = todo el grupo
        } catch {
          // el grupo ya terminó
        }
      };
      const porAbort = matar("cancelado");
      const reloj = setTimeout(matar("plazo"), this.#limiteMs);
      signal.addEventListener("abort", porAbort, { once: true });
      proc.on("error", (e) => {
        clearTimeout(reloj);
        signal.removeEventListener("abort", porAbort);
        reject(e);
      });
      proc.on("close", (codigo) => {
        clearTimeout(reloj);
        signal.removeEventListener("abort", porAbort);
        resolve({ codigo: codigo ?? -1, stdout, combinada, motivo });
      });
      proc.stdin.on("error", () => {}); // el proceso puede salir antes de leer la entrada
      proc.stdin.end(entrada);
      if (signal.aborted) porAbort();
    });
  }
}
