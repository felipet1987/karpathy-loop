// Puerto de entrada: los casos de uso que un adaptador de entrada (consola, HTTP, tests)
// puede disparar. Aquí viven las reglas que no dependen de quién llama: repo limpio,
// worktree por corrida, cancelación y avisos de progreso.
import { createActor, type AnyActorLogic } from "xstate";
import { crearMaquinaExterna, type PuertosExterno, type SalidaExterno } from "./externo.ts";
import { crearMaquinaInterna, type SalidaInterno } from "./interno.ts";
import type { Bitacora, Repositorio } from "./puertos.ts";

export interface OpcionesInterna {
  etiqueta: string;
  iteraciones: number;
  minutos: number;
  topeUsd: number; // Infinity = sin tope
}

export interface OpcionesExterna {
  etiqueta: string;
  versiones: number;
  iteracionesPorTanda: number;
  minutosPorTanda: number;
  topeUsdPorTanda: number; // Infinity = sin tope
}

/** Recibe cada cambio de estado de la máquina (p. ej. `"escribiendoChecks"`). */
export type Aviso = (estado: string) => void;

export interface Corridas {
  interna(opciones: OpcionesInterna, aviso: Aviso, signal: AbortSignal): Promise<SalidaInterno>;
  externa(opciones: OpcionesExterna, aviso: Aviso, signal: AbortSignal): Promise<SalidaExterno>;
}

/** El caso de uso no se puede correr en el estado actual (salida 1 en la consola). */
export class Rechazo extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "Rechazo";
  }
}

export class RepoConCambios extends Rechazo {
  constructor() {
    super("El repo tiene cambios sin commitear; las máquinas hacen checkout y los perderían.");
    this.name = "RepoConCambios";
  }
}

export class CorridaCancelada extends Error {
  constructor() {
    super("Corrida cancelada: se detuvieron los procesos en curso.");
    this.name = "CorridaCancelada";
  }
}

export interface DependenciasCorridas extends PuertosExterno {
  /** results.tsv de una corrida interna suelta, dentro de su worktree. */
  bitacoraDeCorrida: (worktree: Repositorio) => Bitacora;
}

// Abortar detiene el actor: XState aborta los signals de los actores en curso y cada
// adaptador mata su grupo de procesos.
export function correr<T>(logica: AnyActorLogic, input: unknown, aviso: Aviso, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const actor = createActor(logica, { input });
    let anterior = "";
    actor.subscribe({
      next: (s) => {
        const estado = JSON.stringify(s.value);
        if (estado !== anterior) aviso(estado);
        anterior = estado;
      },
      complete: () => {
        if (!signal.aborted) resolve(actor.getSnapshot().output as T);
      },
      error: reject,
    });
    signal.addEventListener(
      "abort",
      () => {
        actor.stop();
        reject(new CorridaCancelada());
      },
      { once: true },
    );
    if (signal.aborted) return reject(new CorridaCancelada());
    actor.start();
  });
}

export function crearCorridas(d: DependenciasCorridas): Corridas {
  const { repositorio } = d;

  const exigirLimpio = () => {
    if (repositorio.tocados().length > 0) throw new RepoConCambios();
  };

  return {
    async interna(o, aviso, signal) {
      exigirLimpio();
      const worktree = repositorio.worktree(o.etiqueta, repositorio.commitCorto());
      return correr<SalidaInterno>(
        crearMaquinaInterna(d),
        {
          repositorio: worktree,
          bitacora: d.bitacoraDeCorrida(worktree),
          programa: repositorio.contenido("program.md"),
          maxIteraciones: o.iteraciones,
          minutos: o.minutos,
          topeUsd: o.topeUsd,
        },
        aviso,
        signal,
      );
    },
    async externa(o, aviso, signal) {
      exigirLimpio();
      return correr<SalidaExterno>(
        crearMaquinaExterna(d),
        {
          base: repositorio.commitCorto(),
          prefijo: o.etiqueta,
          versiones: o.versiones,
          iteracionesPorTanda: o.iteracionesPorTanda,
          minutosPorTanda: o.minutosPorTanda,
          topeUsdPorTanda: o.topeUsdPorTanda,
        },
        aviso,
        signal,
      );
    },
  };
}
