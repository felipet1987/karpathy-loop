// Puertos: lo único que el núcleo sabe del mundo exterior. Los adaptadores viven en
// src/adaptadores/ y se cablean en src/cli.ts.

export type Fase = "checks" | "build" | "programa" | "write-checks" | "feature-builder" | "auto-loop";

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

/** Un agente que falló después de gastar: el costo viaja con el error para que no se pierda. */
export class FalloDeAgente extends Error {
  readonly costoUsd: number;

  constructor(mensaje: string, costoUsd: number) {
    super(mensaje);
    this.name = "FalloDeAgente";
    this.costoUsd = costoUsd;
  }
}

/** Lo gastado por una llamada que terminó en error; 0 si el error no lo informa. */
export const costoDe = (error: unknown) => (error instanceof FalloDeAgente ? error.costoUsd : 0);

/** `signal` se aborta cuando la máquina abandona el estado: el adaptador debe cortar el proceso. */
export interface Agente {
  respuesta(encargo: Encargo, signal: AbortSignal): Promise<Respuesta>;
}

export interface Checks {
  resultado(dir: string): Promise<ResultadoChecks>;
}

/** Puntaje de una ronda: cuántos checks de la carpeta pasan. */
export interface Puntaje {
  pasados: number;
  total: number;
  /** Nombres de los checks que fallaron. */
  fallidos: string[];
  salida: string;
}

export interface Evaluador {
  /** Corre cada check de `carpeta` (relativa a `dir`); `signal` corta el check en curso. */
  puntaje(dir: string, carpeta: string, signal: AbortSignal): Promise<Puntaje>;
}

export interface Entrenador {
  medicion(dir: string, signal: AbortSignal): Promise<Medicion>;
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
  /** La ruta (archivo o carpeta) está versionada en HEAD. */
  existe(ruta: string): boolean;
  /** Crea un worktree en una rama nueva (por defecto `autoresearch/<etiqueta>`) y devuelve su repositorio. */
  worktree(etiqueta: string, base: string, rama?: string): Repositorio;
  /** Un worktree creado antes con esa etiqueta; falla si no existe. */
  abierto(etiqueta: string): Repositorio;
  quitar(worktree: Repositorio): void;
}
