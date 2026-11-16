// Encargos: qué se le pide al agente en cada fase. Las fases son dominio; cómo se
// ejecuta el agente (claude -p) es del adaptador.
import type { Encargo } from "./puertos.ts";

/** Carpeta de checks: la escribe la fase 1 y queda bloqueada en la fase 2. */
export const CHECKS = "checks/";

const LECTURA = ["Read", "Glob", "Grep"];

/** Fase 1 (write checks): decide el cambio y escribe en checks/ lo que el cambio debe cumplir. */
export function encargoChecks(dir: string, programa: string, historial: string): Encargo {
  return {
    fase: "checks",
    systemPrompt: programa,
    prompt:
      `Historial de iteraciones (results.tsv):\n\n${historial || "(vacío)"}\n\n` +
      `Fase 1 de 3 (write checks). Decide UN cambio al proyecto, según el objetivo de tus ` +
      `instrucciones, pero NO lo implementes todavía: escribe o ajusta checks en ${CHECKS} que ` +
      `verifiquen que el cambio quedó bien hecho. No toques nada fuera de ${CHECKS}. ` +
      `Responde solo con una línea que describa el cambio.`,
    cwd: dir,
    herramientas: [...LECTURA, "Write", "Edit"],
  };
}

/** Fase 2 (build): implementa el cambio; si hubo fallo, trae la salida de los checks. */
export function encargoBuild(dir: string, programa: string, descripcion: string, fallo: string | null): Encargo {
  const anterior = fallo
    ? `\n\nEl intento anterior no pasó los checks. Salida:\n\n${fallo}\n\nCorrige el código.`
    : "";
  return {
    fase: "build",
    systemPrompt: programa,
    prompt:
      `Fase 2 de 3 (build). Implementa: ${descripcion}\n` +
      `Los checks de ${CHECKS} tienen que pasar; no los modifiques.${anterior}`,
    cwd: dir,
    herramientas: [...LECTURA, "Write", "Edit"],
  };
}

/** Meta-agente: reescribe program.md a partir de los resultados de las tandas. */
export function encargoPrograma(raiz: string, metaPrompt: string): Encargo {
  return {
    fase: "programa",
    systemPrompt: metaPrompt,
    prompt: "Lee meta/ y program.md, y haz UN cambio a program.md.",
    cwd: raiz,
    herramientas: [...LECTURA, "Edit"],
  };
}

/** La descripción del cambio es la última línea de la respuesta, recortada. */
export const descripcionDe = (texto: string) => (texto.trim().split("\n").at(-1) ?? "").slice(0, 200);
