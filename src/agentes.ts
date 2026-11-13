// Puertos reales. El paso 4 mueve esta construcción a cli.ts y borra el archivo.
import { ChecksUv } from "./adaptadores/checks-uv.ts";
import { ClaudeCli } from "./adaptadores/claude-cli.ts";
import { EntrenadorUv } from "./adaptadores/entrenador-uv.ts";
import { SalidaRecortada } from "./adaptadores/salida-recortada.ts";

export const agente = new ClaudeCli(
  process.env.KL_MODELO ?? "claude-opus-5-5",
  Number(process.env.KL_PRESUPUESTO_AGENTE_USD ?? 2),
  15 * 60_000,
);
export const checks = new SalidaRecortada(new ChecksUv(60_000), 4_000);
export const entrenador = new EntrenadorUv(60_000);
