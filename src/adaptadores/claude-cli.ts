import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agente, Encargo, Respuesta } from "../nucleo/puertos.ts";

const ejecutar = promisify(execFile);

/** Agente sobre Claude Code headless: `claude -p --output-format json`, prompt por stdin. */
export class ClaudeCli implements Agente {
  readonly #modelo: string;
  readonly #presupuestoUsd: number;
  readonly #limiteMs: number;

  constructor(modelo: string, presupuestoUsd: number, limiteMs: number) {
    this.#modelo = modelo;
    this.#presupuestoUsd = presupuestoUsd;
    this.#limiteMs = limiteMs;
  }

  async respuesta(encargo: Encargo): Promise<Respuesta> {
    const herramientas = encargo.herramientas.join(",");
    const proceso = ejecutar(
      "claude",
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
    const { stdout } = await proceso;
    const r = JSON.parse(stdout) as { subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number };
    if (r.is_error || r.subtype !== "success") throw new Error(`claude -p ${r.subtype}: ${r.result ?? ""}`);
    return { texto: (r.result ?? "").trim(), costoUsd: r.total_cost_usd ?? 0 };
  }
}
