// Puerto de entrada del flujo por feature:
//
//   pedido en features.md → write-checks → revisión humana → approve-checks
//     → rondas (feature-builder + correr checks, conservar o deshacer) → reporte final
//   registro de rondas → auto-loop → program.md (guía al builder)
//
// La revisión humana separa dos casos de uso: `checks` deja los checks sin commitear en el
// worktree de la feature; la persona los lee o los edita y `aprobar` los commitea y corre las
// rondas. Desde ese commit, la carpeta de checks queda bloqueada para el builder.
import { correr, CorridaCancelada, Rechazo, type Aviso } from "./corridas.ts";
import { descripcionDe } from "./encargos.ts";
import { carpetaDeChecks, crearMaquinaFeature, type PuertosFeature, type SalidaFeature } from "./feature.ts";
import type { Bitacora, Encargo, Repositorio, Respuesta } from "./puertos.ts";

export const PEDIDOS = "features.md";
export const PROGRAMA = "program.md";

export interface OpcionesChecks {
  repo: string;
  id: string;
}

export interface OpcionesAprobar {
  repo: string;
  id: string;
  rondas: number;
  topeUsd: number; // Infinity = sin tope
}

export interface OpcionesMejorar {
  repo: string;
}

export interface ChecksEscritos {
  id: string;
  worktree: string; // donde la persona revisa los checks
  archivos: string[];
  descripcion: string;
  costoUsd: number;
}

export interface FeatureTerminada extends SalidaFeature {
  reporte: string; // ruta del reporte final
}

export interface Mejora {
  estado: "conservado" | "revertido" | "sin_cambios";
  descripcion: string;
  tocados: string[];
  costoUsd: number;
}

export interface Features {
  checks(o: OpcionesChecks, signal: AbortSignal): Promise<ChecksEscritos>;
  aprobar(o: OpcionesAprobar, aviso: Aviso, signal: AbortSignal): Promise<FeatureTerminada>;
  mejorar(o: OpcionesMejorar, signal: AbortSignal): Promise<Mejora>;
}

export interface DependenciasFeatures extends PuertosFeature {
  /** Repo git que contiene la ruta. */
  repositorio(ruta: string): Repositorio;
  /** Registro de rondas de la feature, en el repo principal. */
  rondas(repo: Repositorio, id: string): Bitacora;
  /** Escribe el reporte final y devuelve su ruta. */
  reporte(repo: Repositorio, id: string, texto: string): string;
}

/** Cada feature es un título `## <id>` en features.md; lo que sigue es el pedido. */
export const idsDe = (pedidos: string) => [...pedidos.matchAll(/^##\s+([\w.-]+)\s*$/gm)].map((m) => m[1]);

const etiquetaDe = (id: string) => `feature-${id}`;

const PROGRAMA_POR_DEFECTO = "Trabajas en un repositorio de código. Sigue las instrucciones de la skill.";

/** Reporte final: el puntaje y, por ronda, los checks que fallaban (errores) y el cambio intentado (arreglo). */
export function reporteDe(salida: SalidaFeature, rondas: string): string {
  const filas = rondas
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const tabla = filas.map(([ronda, commit, puntaje, estado, fallos, descripcion]) =>
    `| ${ronda} | ${commit} | ${puntaje} | ${estado} | ${fallos || "-"} | ${descripcion || "-"} |`,
  );
  return [
    `# Reporte: ${salida.id}`,
    "",
    `- Estado: ${salida.completa ? "completa, todos los checks pasan" : "incompleta"}`,
    `- Puntaje: ${salida.puntaje}`,
    `- Rondas: ${salida.rondas}`,
    `- Costo: ${salida.costoUsd.toFixed(2)} USD`,
    "",
    "## Errores y arreglos por ronda",
    "",
    "| ronda | commit | puntaje | estado | checks que fallan | cambio |",
    "|---|---|---|---|---|---|",
    ...tabla,
    "",
  ].join("\n");
}

export function crearFeatures(d: DependenciasFeatures): Features {
  const programaDe = (repo: Repositorio) => (repo.existe(PROGRAMA) ? repo.vigente(PROGRAMA) : PROGRAMA_POR_DEFECTO);

  const llamar = async (encargo: Encargo, signal: AbortSignal): Promise<Respuesta> => {
    try {
      return await d.agente.respuesta(encargo, signal);
    } catch (e) {
      if (signal.aborted) throw new CorridaCancelada();
      throw e;
    }
  };

  /** El pedido tiene que estar commiteado: el worktree sale de HEAD. */
  const exigirPedido = (repo: Repositorio, id: string) => {
    if (!repo.existe(PEDIDOS)) throw new Rechazo(`No hay ${PEDIDOS} commiteado en ${repo.directorio()}.`);
    if (!idsDe(repo.vigente(PEDIDOS)).includes(id)) {
      throw new Rechazo(`La feature «${id}» no está en ${PEDIDOS} (se espera un título "## ${id}" commiteado).`);
    }
  };

  const abierto = (repo: Repositorio, id: string): Repositorio | undefined => {
    try {
      return repo.abierto(etiquetaDe(id));
    } catch {
      return undefined;
    }
  };

  return {
    // write-checks: tests antes del código. Quedan sin commitear para la revisión humana.
    async checks(o, signal) {
      const repo = d.repositorio(o.repo);
      exigirPedido(repo, o.id);
      const carpeta = carpetaDeChecks(o.id);
      let wt = abierto(repo, o.id);
      if (wt?.existe(carpeta)) throw new Rechazo(`Los checks de «${o.id}» ya están aprobados; usar \`feature aprobar\`.`);
      if (wt) wt.descartar(); // se reescriben desde cero
      wt ??= repo.worktree(etiquetaDe(o.id), repo.commitCorto(), `feature/${o.id}`);
      const respuesta = await llamar(
        {
          fase: "write-checks",
          systemPrompt: programaDe(wt),
          prompt: `/kl:write-checks ${o.id}`,
          cwd: wt.directorio(),
          herramientas: ["Read", "Glob", "Grep", "Write", "Edit"],
        },
        signal,
      ).catch((e) => {
        wt.descartar();
        throw e;
      });
      const tocados = wt.tocados();
      const fuera = tocados.filter((r) => !r.startsWith(carpeta));
      if (fuera.length > 0) {
        wt.descartar();
        throw new Rechazo(`write-checks tocó archivos fuera de ${carpeta}: ${fuera.join(", ")}. Se descartó todo.`);
      }
      if (tocados.length === 0) throw new Rechazo(`write-checks no escribió nada en ${carpeta}.`);
      return {
        id: o.id,
        worktree: wt.directorio(),
        archivos: tocados,
        descripcion: descripcionDe(respuesta.texto),
        costoUsd: respuesta.costoUsd,
      };
    },

    // approve-checks: commitea la carpeta (desde aquí es inmutable) y corre las rondas.
    // Se puede repetir para seguir con más rondas sobre los checks ya aprobados.
    async aprobar(o, aviso, signal) {
      const repo = d.repositorio(o.repo);
      const carpeta = carpetaDeChecks(o.id);
      const wt = abierto(repo, o.id);
      if (!wt) throw new Rechazo(`No hay worktree para «${o.id}»; correr antes \`feature checks ${o.id}\`.`);
      const tocados = wt.tocados();
      const fuera = tocados.filter((r) => !r.startsWith(carpeta));
      if (fuera.length > 0) {
        throw new Rechazo(`Hay cambios fuera de ${carpeta}: ${fuera.join(", ")}. Commitearlos o descartarlos antes de aprobar.`);
      }
      if (tocados.length > 0) wt.confirmar(`checks aprobados: ${o.id}`, [carpeta]);
      if (!wt.existe(carpeta)) throw new Rechazo(`No hay checks en ${carpeta} para aprobar.`);
      const bitacora = d.rondas(repo, o.id);
      const salida = await correr<SalidaFeature>(
        crearMaquinaFeature(d),
        { id: o.id, repositorio: wt, bitacora, programa: programaDe(wt), maxRondas: o.rondas, topeUsd: o.topeUsd },
        aviso,
        signal,
      );
      return { ...salida, reporte: d.reporte(repo, o.id, reporteDe(salida, bitacora.texto())) };
    },

    // auto-loop: lee el registro de rondas y reescribe program.md. Si toca otra cosa, se revierte.
    async mejorar(o, signal) {
      const repo = d.repositorio(o.repo);
      if (!repo.existe(PROGRAMA)) throw new Rechazo(`No hay ${PROGRAMA} commiteado en ${repo.directorio()}.`);
      const antes = new Set(repo.tocados());
      if (antes.has(PROGRAMA)) throw new Rechazo(`${PROGRAMA} tiene cambios sin commitear.`);
      const respuesta = await llamar(
        {
          fase: "auto-loop",
          systemPrompt: "Eres el auto-loop: mejoras program.md a partir del registro de rondas.",
          prompt: "/kl:auto-loop",
          cwd: repo.directorio(),
          herramientas: ["Read", "Glob", "Grep", "Edit"],
        },
        signal,
      );
      const descripcion = descripcionDe(respuesta.texto);
      const tocados = repo.tocados().filter((r) => !antes.has(r));
      const base = { descripcion, tocados, costoUsd: respuesta.costoUsd };
      if (tocados.length === 0) return { estado: "sin_cambios", ...base };
      if (tocados.some((r) => r !== PROGRAMA)) {
        for (const r of tocados) repo.restaurar(r);
        return { estado: "revertido", ...base };
      }
      repo.confirmar(`auto-loop: ${descripcion}`, [PROGRAMA]);
      return { estado: "conservado", ...base };
    },
  };
}
