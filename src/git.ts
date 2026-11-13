// Operaciones de git y de results.tsv que usan las dos máquinas.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Rutas con cambios sin commitear (incluye archivos nuevos no ignorados). */
export function cambiados(cwd: string): string[] {
  // Sin trim: la primera línea empieza con espacio (" M train.py") y la columna importa.
  return execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((linea) => linea.slice(3));
}

/** Crea un worktree en .trabajo/<etiqueta> sobre la rama nueva autoresearch/<etiqueta>. */
export function crearWorktree(raiz: string, etiqueta: string, base: string): string {
  const dir = join(raiz, ".trabajo", etiqueta);
  git(raiz, "worktree", "add", "-q", dir, "-b", `autoresearch/${etiqueta}`, base);
  return dir;
}

export interface Fila {
  commit: string;
  valLoss: number;
  status: "keep" | "discard" | "crash" | "fuera_de_alcance" | "checks_fallidos";
  descripcion: string;
}

export function registrar(dir: string, fila: Fila): void {
  const ruta = join(dir, "results.tsv");
  if (!existsSync(ruta)) writeFileSync(ruta, "commit\tval_loss\tstatus\tdescription\n");
  const desc = fila.descripcion.replace(/[\t\n]+/g, " ");
  appendFileSync(ruta, `${fila.commit}\t${fila.valLoss.toFixed(6)}\t${fila.status}\t${desc}\n`);
}
