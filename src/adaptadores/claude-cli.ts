import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FalloDeAgente, type Agente, type Encargo, type Respuesta } from "../nucleo/puertos.ts";

const ejecutar = promisify(execFile);

/** Agente sobre Claude Code headless: `claude -p --output-format json`, prompt por stdin. */
export class ClaudeCli implements Agente {
  readonly #binario: string;
  readonly #modelo: string;
  readonly #presupuestoUsd: number;
  readonly #limiteMs: number;

  constructor(binario: string, modelo: string, presupuestoUsd: number, limiteMs: number) {
    this.#binario = binario;
    this.#modelo = modelo;
    this.#presupuestoUsd = presupuestoUsd;
    this.#limiteMs = limiteMs;
  }

  async respuesta(encargo: Encargo): Promise<Respuesta> {
    const herramientas = encargo.herramientas.join(",");
    const proceso = ejecutar(
      this.#binario,
      [
        "-p",
        "--output-format", "json",
        "--system-prompt", encargo.systemPrompt,
        "--tools", herramientas,
        "--allowedTools", herramientas,
        "--permission-mode", "dontAsk", // no hay nadie para aprobar: lo que no está permitido se niega
        "--setting-sources", "", // sin hooks ni CLAUDE.md del usuario
        "--no-session-persistence",
        "--model", this.#modelo,
        "--max-budget-usd", String(this.#presupuestoUsd),
      ],
      { cwd: encargo.cwd, timeout: this.#limiteMs, maxBuffer: 64 * 1024 * 1024 },
    );
    proceso.child.stdin!.end(encargo.prompt);
    // Con código de salida ≠ 0 (p. ej. error_max_budget_usd) el JSON con el costo sigue en stdout.
    const stdout = await proceso.then(
      (r) => r.stdout,
      (e: { stdout?: string }) => e.stdout || Promise.reject(e),
    );
    let r: { subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number };
    try {
      r = JSON.parse(stdout);
    } catch {
      throw new FalloDeAgente(`claude -p: salida que no es JSON: ${stdout.slice(0, 200)}`, 0);
    }
    const costoUsd = r.total_cost_usd ?? 0;
    if (r.is_error || r.subtype !== "success") {
      throw new FalloDeAgente(`claude -p ${r.subtype}: ${r.result ?? ""}`, costoUsd);
    }
    return { texto: (r.result ?? "").trim(), costoUsd };
  }
}
