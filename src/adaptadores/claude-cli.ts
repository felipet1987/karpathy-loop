import { FalloDeAgente, type Agente, type Encargo, type Respuesta } from "../nucleo/puertos.ts";
import { ProcesoEnGrupo } from "./proceso-en-grupo.ts";

/** Agente sobre Claude Code headless: `claude -p --output-format json`, prompt por stdin. */
export class ClaudeCli implements Agente {
  readonly #binario: string;
  readonly #modelo: string;
  readonly #presupuestoUsd: number;
  readonly #limiteMs: number;
  readonly #plugins: readonly string[];

  /** `plugins`: carpetas de plugins de Claude Code (p. ej. las skills `kl:*`), solo para esta sesión. */
  constructor(binario: string, modelo: string, presupuestoUsd: number, limiteMs: number, plugins: readonly string[] = []) {
    this.#binario = binario;
    this.#modelo = modelo;
    this.#presupuestoUsd = presupuestoUsd;
    this.#limiteMs = limiteMs;
    this.#plugins = plugins;
  }

  async respuesta(encargo: Encargo, signal: AbortSignal): Promise<Respuesta> {
    const herramientas = encargo.herramientas.join(",");
    const args = [
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
      ...this.#plugins.flatMap((p) => ["--plugin-dir", p]),
    ];
    const s = await new ProcesoEnGrupo(this.#binario, args, encargo.cwd, this.#limiteMs).salida(encargo.prompt, signal);
    if (s.motivo !== "fin") throw new FalloDeAgente(`claude -p ${s.motivo}`, 0);
    // Con código de salida ≠ 0 (p. ej. error_max_budget_usd) el JSON con el costo sigue en stdout.
    let r: { subtype?: string; is_error?: boolean; result?: string; total_cost_usd?: number };
    try {
      r = JSON.parse(s.stdout);
    } catch {
      throw new FalloDeAgente(`claude -p (código ${s.codigo}): ${s.combinada.slice(-200)}`, 0);
    }
    const costoUsd = r.total_cost_usd ?? 0;
    if (r.is_error || r.subtype !== "success") {
      throw new FalloDeAgente(`claude -p ${r.subtype}: ${r.result ?? ""}`, costoUsd);
    }
    return { texto: (r.result ?? "").trim(), costoUsd };
  }
}
