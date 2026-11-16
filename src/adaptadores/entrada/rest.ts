import type { IncomingMessage, ServerResponse } from "node:http";
import { CorridaCancelada, Rechazo, type Corridas } from "../../nucleo/corridas.ts";
import type { Features } from "../../nucleo/features.ts";
import { nombre, opcionesAprobar, opcionesExterna, opcionesInterna, UsoInvalido, type Valor } from "./validacion.ts";

/**
 * Adaptador de entrada REST. Las corridas duran minutos, así que cada POST crea un trabajo
 * asíncrono y responde 202 con su URL; el estado se consulta con GET y se cancela con DELETE.
 *
 *   POST   /corridas/interna             {etiqueta?, iteraciones?, minutos?, topeUsd?}
 *   POST   /corridas/externa             {etiqueta?, versiones?, iteraciones?, minutos?, topeUsd?}
 *   POST   /features/{id}/checks         {repo?}
 *   POST   /features/{id}/aprobar        {repo?, rondas?, topeUsd?}
 *   POST   /features/mejorar             {repo?}
 *   GET    /trabajos                     lista
 *   GET    /trabajos/{n}                 estado, avisos, salida o error
 *   DELETE /trabajos/{n}                 cancela
 *
 * Un trabajo a la vez (409 si hay otro corriendo): las corridas comparten el repo.
 */
export class Rest {
  readonly #corridas: Corridas;
  readonly #features: Features;
  readonly #trabajos: Map<number, Trabajo>;

  constructor(corridas: Corridas, features: Features) {
    this.#corridas = corridas;
    this.#features = features;
    this.#trabajos = new Map();
  }

  /** Para `http.createServer`. */
  manejador(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      this.#atender(req).then(
        (r) => responder(res, r),
        (e) => responder(res, { codigo: 500, cuerpo: { error: e instanceof Error ? e.message : String(e) } }),
      );
    };
  }

  /** Cancela todo trabajo en curso (p. ej. al apagar el servidor). */
  cancelarTodo(): void {
    for (const t of this.#trabajos.values()) t.corte.abort();
  }

  async #atender(req: IncomingMessage): Promise<Respuesta> {
    const partes = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
    const ruta = `${req.method} /${partes.join("/")}`;
    try {
      if (req.method === "GET" && partes.length === 1 && partes[0] === "trabajos") {
        return { codigo: 200, cuerpo: [...this.#trabajos.values()].map(vista) };
      }
      if (partes.length === 2 && partes[0] === "trabajos") {
        const t = this.#trabajos.get(Number(partes[1]));
        if (!t) return { codigo: 404, cuerpo: { error: `no existe el trabajo ${partes[1]}` } };
        if (req.method === "GET") return { codigo: 200, cuerpo: vista(t) };
        if (req.method === "DELETE") {
          t.corte.abort();
          await t.fin;
          return { codigo: 200, cuerpo: vista(t) };
        }
        return metodoNoPermitido(ruta);
      }
      if (req.method !== "POST") return noEncontrado(ruta);
      const caso = this.#caso(partes, await cuerpoJson(req));
      if (!caso) return noEncontrado(ruta);
      return await this.#lanzar(ruta, caso);
    } catch (e) {
      if (e instanceof UsoInvalido) return { codigo: 400, cuerpo: { error: e.message } };
      throw e;
    }
  }

  /** Traduce la ruta y el cuerpo a un caso de uso; valida antes de lanzar nada. */
  #caso(partes: string[], c: Record<string, Valor>): Caso | undefined {
    const repo = c.repo === undefined ? "." : String(c.repo);
    const [a, b, accion] = partes;
    if (a === "corridas" && partes.length === 2 && b === "interna") {
      const o = opcionesInterna(c);
      return (aviso, signal) => this.#corridas.interna(o, aviso, signal);
    }
    if (a === "corridas" && partes.length === 2 && b === "externa") {
      const o = opcionesExterna(c);
      return (aviso, signal) => this.#corridas.externa(o, aviso, signal);
    }
    if (a === "features" && partes.length === 2 && b === "mejorar") {
      return (_, signal) => this.#features.mejorar({ repo }, signal);
    }
    if (a === "features" && partes.length === 3 && accion === "checks") {
      const id = nombre("id", b);
      return (_, signal) => this.#features.checks({ repo, id }, signal);
    }
    if (a === "features" && partes.length === 3 && accion === "aprobar") {
      const o = opcionesAprobar(repo, b, c);
      return (aviso, signal) => this.#features.aprobar(o, aviso, signal);
    }
    return undefined;
  }

  async #lanzar(ruta: string, caso: Caso): Promise<Respuesta> {
    const enCurso = [...this.#trabajos.values()].find((t) => t.estado === "corriendo");
    if (enCurso) return { codigo: 409, cuerpo: { error: "ya hay un trabajo corriendo", trabajo: `/trabajos/${enCurso.id}` } };
    const t: Trabajo = {
      id: this.#trabajos.size + 1,
      ruta,
      estado: "corriendo",
      inicio: new Date().toISOString(),
      avisos: [],
      corte: new AbortController(),
      fin: Promise.resolve(),
    };
    this.#trabajos.set(t.id, t);
    const aviso = (estado: string) => {
      t.avisos.push({ hora: new Date().toISOString(), estado });
      if (t.avisos.length > 200) t.avisos.shift();
    };
    t.fin = caso(aviso, t.corte.signal).then(
      (salida) => cerrar(t, "terminado", { salida }),
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        if (e instanceof CorridaCancelada) cerrar(t, "cancelado", { error });
        else if (e instanceof Rechazo) cerrar(t, "rechazado", { error });
        else cerrar(t, "fallido", { error });
      },
    );
    // Los rechazos (repo sucio, feature inexistente) ocurren antes del primer await del caso
    // de uso: se esperan un turno del event loop para responderlos como 422 en el acto.
    await new Promise((r) => setImmediate(r));
    if (t.estado === "rechazado") {
      this.#trabajos.delete(t.id);
      return { codigo: 422, cuerpo: { error: t.error } };
    }
    return { codigo: 202, cuerpo: vista(t), ubicacion: `/trabajos/${t.id}` };
  }
}

type Caso = (aviso: (estado: string) => void, signal: AbortSignal) => Promise<unknown>;

interface Trabajo {
  id: number;
  ruta: string;
  estado: "corriendo" | "terminado" | "cancelado" | "rechazado" | "fallido";
  inicio: string;
  fin_en?: string;
  avisos: { hora: string; estado: string }[];
  salida?: unknown;
  error?: string;
  corte: AbortController;
  fin: Promise<void>;
}

interface Respuesta {
  codigo: number;
  cuerpo: unknown;
  ubicacion?: string;
}

function cerrar(t: Trabajo, estado: Trabajo["estado"], datos: { salida?: unknown; error?: string }) {
  Object.assign(t, { estado, fin_en: new Date().toISOString() }, datos);
}

/** Lo que se publica de un trabajo: sin el controlador ni la promesa. */
const vista = ({ corte: _c, fin: _f, ...t }: Trabajo) => ({ ...t, url: `/trabajos/${t.id}` });

const noEncontrado = (ruta: string): Respuesta => ({ codigo: 404, cuerpo: { error: `no existe ${ruta}` } });
const metodoNoPermitido = (ruta: string): Respuesta => ({ codigo: 405, cuerpo: { error: `método no permitido: ${ruta}` } });

const LIMITE_CUERPO = 64 * 1024;

async function cuerpoJson(req: IncomingMessage): Promise<Record<string, Valor>> {
  let texto = "";
  for await (const trozo of req) {
    texto += trozo;
    if (texto.length > LIMITE_CUERPO) throw new UsoInvalido("cuerpo demasiado grande");
  }
  if (texto.trim() === "") return {};
  let valor: unknown;
  try {
    valor = JSON.parse(texto);
  } catch {
    throw new UsoInvalido("el cuerpo no es JSON válido");
  }
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) {
    throw new UsoInvalido("el cuerpo tiene que ser un objeto JSON");
  }
  for (const [k, v] of Object.entries(valor)) {
    if (typeof v !== "string" && typeof v !== "number") throw new UsoInvalido(`${k} tiene que ser texto o número`);
  }
  return valor as Record<string, Valor>;
}

function responder(res: ServerResponse, r: Respuesta) {
  // Infinity (sin tope de USD) no existe en JSON: se publica como null.
  const cuerpo = JSON.stringify(r.cuerpo, (_, v) => (v === Infinity ? null : v), 2);
  res.writeHead(r.codigo, {
    "content-type": "application/json; charset=utf-8",
    ...(r.ubicacion ? { location: r.ubicacion } : {}),
  });
  res.end(cuerpo);
}
