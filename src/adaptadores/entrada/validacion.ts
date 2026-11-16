// Validación y valores por defecto comunes a los adaptadores de entrada (consola y REST): un
// mismo pedido produce las mismas opciones venga de donde venga.
import type { OpcionesExterna, OpcionesInterna } from "../../nucleo/corridas.ts";
import type { OpcionesAprobar } from "../../nucleo/features.ts";

/** El pedido está mal formado; el adaptador lo traduce (código 2, HTTP 400). */
export class UsoInvalido extends Error {}

/** Un valor leído de la entrada: texto (consola), número o texto (JSON), o ausente. */
export type Valor = string | number | undefined;

/** Nombre seguro para una rama y una carpeta: sin barras, sin `..` y sin empezar con punto. */
export function nombre(campo: string, valor: string): string {
  if (!/^[\w-][\w.-]*$/.test(valor) || valor.includes("..")) throw new UsoInvalido(`${campo} inválido: ${valor}`);
  return valor;
}

export function positivo(campo: string, valor: Valor, porDefecto: number): number {
  if (valor === undefined) return porDefecto;
  const n = Number(valor);
  if (valor === "" || !Number.isFinite(n) || n <= 0) {
    throw new UsoInvalido(`${campo} tiene que ser un número mayor que 0: ${valor}`);
  }
  return n;
}

export function entero(campo: string, valor: Valor, porDefecto: number): number {
  const n = positivo(campo, valor, porDefecto);
  if (!Number.isInteger(n)) throw new UsoInvalido(`${campo} tiene que ser entero: ${valor}`);
  return n;
}

const etiqueta = (valor: Valor) =>
  nombre("etiqueta", valor === undefined ? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "") : String(valor));

export interface ValoresCorrida {
  etiqueta?: Valor;
  iteraciones?: Valor;
  minutos?: Valor;
  versiones?: Valor;
  topeUsd?: Valor;
}

export const opcionesInterna = (v: ValoresCorrida): OpcionesInterna => ({
  etiqueta: etiqueta(v.etiqueta),
  iteraciones: entero("iteraciones", v.iteraciones, 10),
  minutos: positivo("minutos", v.minutos, 15),
  topeUsd: positivo("tope-usd", v.topeUsd, Infinity),
});

export const opcionesExterna = (v: ValoresCorrida): OpcionesExterna => ({
  etiqueta: etiqueta(v.etiqueta),
  versiones: entero("versiones", v.versiones, 4),
  iteracionesPorTanda: entero("iteraciones", v.iteraciones, 8),
  minutosPorTanda: positivo("minutos", v.minutos, 10),
  topeUsdPorTanda: positivo("tope-usd", v.topeUsd, Infinity),
});

export const opcionesAprobar = (
  repo: string,
  id: string,
  v: { rondas?: Valor; topeUsd?: Valor },
): OpcionesAprobar => ({
  repo,
  id: nombre("id", id),
  rondas: entero("rondas", v.rondas, 5),
  topeUsd: positivo("tope-usd", v.topeUsd, Infinity),
});
