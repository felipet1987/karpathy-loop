import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repositorio } from "../nucleo/puertos.ts";

/** Repositorio sobre git: cada método es un comando en el directorio dado. */
export class RepositorioGit implements Repositorio {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  directorio(): string {
    return this.#dir;
  }

  tocados(): string[] {
    // Sin trim: la primera línea empieza con espacio (" M train.py") y la columna importa.
    return this.#crudo("status", "--porcelain")
      .split("\n")
      .filter(Boolean)
      .map((linea) => linea.slice(3));
  }

  tocadosFueraDelIndex(): string[] {
    const modificados = this.#git("diff", "--name-only");
    const nuevos = this.#git("ls-files", "--others", "--exclude-standard");
    return [modificados, nuevos].join("\n").split("\n").filter(Boolean);
  }

  aislar(ruta: string): void {
    this.#git("add", "-A", "--", ruta);
  }

  confirmar(mensaje: string, rutas: readonly string[]): void {
    this.#git("add", "-A", "--", ...rutas);
    this.#git("commit", "-qm", mensaje, "--", ...rutas);
  }

  revertirUltimo(): void {
    this.#git("reset", "-q", "--hard", "HEAD~1");
  }

  descartar(): void {
    this.#git("reset", "-q", "--hard", "HEAD");
    this.#git("clean", "-fdq");
  }

  restaurar(ruta: string): void {
    this.#git("checkout", "-q", "HEAD", "--", ruta);
  }

  commitCorto(): string {
    return this.#git("rev-parse", "--short=7", "HEAD");
  }

  contenido(ruta: string): string {
    return readFileSync(join(this.#dir, ruta), "utf8");
  }

  vigente(ruta: string): string {
    return this.#crudo("show", `HEAD:${ruta}`);
  }

  worktree(etiqueta: string, base: string): Repositorio {
    const dir = join(this.#dir, ".trabajo", etiqueta);
    this.#git("worktree", "add", "-q", dir, "-b", `autoresearch/${etiqueta}`, base);
    return new RepositorioGit(dir);
  }

  quitar(worktree: Repositorio): void {
    this.#git("worktree", "remove", "--force", worktree.directorio());
  }

  #git(...args: string[]): string {
    return this.#crudo(...args).trim();
  }

  #crudo(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.#dir, encoding: "utf8" });
  }
}
