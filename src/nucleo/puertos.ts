// Puertos: lo único que el núcleo sabe del mundo exterior. Los adaptadores viven en
// src/adaptadores/ y se cablean en src/cli.ts.

export type Fase = "checks" | "build" | "programa";

/** Lo que se le pide a un agente. Es un valor: no tiene comportamiento. */
export interface Encargo {
  fase: Fase;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  herramientas: readonly string[];
}

export interface Respuesta {
  texto: string;
  costoUsd: number;
}

export interface ResultadoChecks {
  ok: boolean;
  salida: string;
}

export interface Medicion {
  valLoss: number;
}

export interface Agente {
  respuesta(encargo: Encargo): Promise<Respuesta>;
}

export interface Checks {
  resultado(dir: string): Promise<ResultadoChecks>;
}

export interface Entrenador {
  medicion(dir: string): Promise<Medicion>;
}

/** Registro de filas TSV con encabezado. */
export interface Bitacora {
  anotar(campos: readonly string[]): void;
  /** Todo el registro; vacío si todavía no hay filas. */
  texto(): string;
}

export interface Repositorio {
  directorio(): string;
  /** Rutas con cambios sin commitear, incluidas las nuevas no ignoradas. */
  tocados(): string[];
  /** Cambios que no están en el index: modificados y nuevos. */
  tocadosFueraDelIndex(): string[];
  /** Pasa la ruta al index. */
  aislar(ruta: string): void;
  confirmar(mensaje: string, rutas: readonly string[]): void;
  /** Deshace el último commit y sus cambios. */
  revertirUltimo(): void;
  /** Deshace todo lo no commiteado, incluido el index y los archivos nuevos. */
  descartar(): void;
  /** Devuelve la ruta a su versión de HEAD. */
  restaurar(ruta: string): void;
  commitCorto(): string;
  /** Contenido actual en el working tree. */
  contenido(ruta: string): string;
  /** Contenido en HEAD. */
  vigente(ruta: string): string;
  /** Crea un worktree en una rama nueva y devuelve su repositorio. */
  worktree(etiqueta: string, base: string): Repositorio;
  quitar(worktree: Repositorio): void;
}
