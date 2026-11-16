// Adaptador REST: rutas → casos de uso con Corridas y Features falsas, sobre un servidor real.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Rest } from "../src/adaptadores/entrada/rest.ts";
import { CorridaCancelada, Rechazo, type Corridas } from "../src/nucleo/corridas.ts";
import type { Features } from "../src/nucleo/features.ts";

const llamadas: { caso: string; opciones: unknown }[] = [];
/** Trabajos que quedan abiertos hasta que el test los suelta o los cancela. */
let soltar: () => void = () => {};

const caso = (nombre: string) => async (opciones: unknown, aviso: unknown, signal?: AbortSignal) => {
  llamadas.push({ caso: nombre, opciones });
  const s = (typeof aviso === "function" ? signal : (aviso as AbortSignal))!;
  if (typeof aviso === "function") aviso('"construyendo"');
  if ((opciones as { id?: string }).id === "inexistente") throw new Rechazo("no está en features.md");
  await new Promise<void>((resolve, reject) => {
    soltar = resolve;
    s.addEventListener("abort", () => reject(new CorridaCancelada()), { once: true });
  });
  return { ok: nombre };
};

const corridas = { interna: caso("interna"), externa: caso("externa") } as unknown as Corridas;
const features = { checks: caso("checks"), aprobar: caso("aprobar"), mejorar: caso("mejorar") } as unknown as Features;

let servidor: Server;
let base: string;

before(async () => {
  servidor = createServer(new Rest(corridas, features).manejador());
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

async function pedir(metodo: string, ruta: string, cuerpo?: unknown) {
  const r = await fetch(base + ruta, {
    method: metodo,
    body: cuerpo === undefined ? undefined : typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
  });
  return { codigo: r.status, ubicacion: r.headers.get("location"), cuerpo: await r.json() };
}

const esperar = async (url: string, estado: string) => {
  for (let i = 0; i < 100; i++) {
    const r = await pedir("GET", url);
    if (r.cuerpo.estado === estado) return r.cuerpo;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`${url} no llegó a ${estado}`);
};

test("REST: trabajo asíncrono, 409 con otro en curso, GET con avisos y salida", async () => {
  const r = await pedir("POST", "/corridas/interna", { iteraciones: 3, topeUsd: "2" });
  assert.equal(r.codigo, 202);
  assert.equal(r.ubicacion, "/trabajos/1");
  assert.equal(r.cuerpo.estado, "corriendo");
  assert.deepEqual(llamadas.at(-1)!.opciones, {
    etiqueta: (llamadas.at(-1)!.opciones as { etiqueta: string }).etiqueta,
    iteraciones: 3,
    minutos: 15,
    topeUsd: 2,
  });

  const ocupado = await pedir("POST", "/features/mejorar");
  assert.equal(ocupado.codigo, 409);
  assert.equal(ocupado.cuerpo.trabajo, "/trabajos/1");

  soltar();
  const fin = await esperar("/trabajos/1", "terminado");
  assert.deepEqual(fin.salida, { ok: "interna" });
  assert.equal(fin.avisos[0].estado, '"construyendo"');
  assert.equal(fin.ruta, "POST /corridas/interna");
  assert.equal((await pedir("GET", "/trabajos")).cuerpo.length, 1);
});

test("REST: features y cancelación con DELETE", async () => {
  const r = await pedir("POST", "/features/login/aprobar", { repo: "/r", rondas: 2 });
  assert.equal(r.codigo, 202);
  assert.deepEqual(llamadas.at(-1), { caso: "aprobar", opciones: { repo: "/r", id: "login", rondas: 2, topeUsd: Infinity } });
  const cancelado = await pedir("DELETE", r.ubicacion!);
  assert.equal(cancelado.codigo, 200);
  assert.equal(cancelado.cuerpo.estado, "cancelado");

  const checks = await pedir("POST", "/features/login/checks");
  assert.equal(checks.codigo, 202);
  assert.deepEqual(llamadas.at(-1), { caso: "checks", opciones: { repo: ".", id: "login" } });
  soltar();
  await esperar(checks.ubicacion!, "terminado");
});

test("REST: 400 por pedido inválido, 422 por rechazo y 404/405", async () => {
  for (const [ruta, cuerpo] of [
    ["/corridas/interna", { iteraciones: 2.5 }],
    ["/corridas/externa", { versiones: "abc" }],
    ["/features/..%2Fx/checks", {}],
    ["/features/login/aprobar", { rondas: 0 }],
    ["/corridas/interna", "{no es json"],
    ["/corridas/interna", [1]],
    ["/corridas/interna", { etiqueta: { anidado: true } }],
  ] as const) {
    const r = await pedir("POST", ruta, cuerpo);
    assert.equal(r.codigo, 400, `${ruta} ${JSON.stringify(cuerpo)}`);
  }
  const rechazo = await pedir("POST", "/features/inexistente/checks");
  assert.equal(rechazo.codigo, 422);
  assert.equal(rechazo.cuerpo.error, "no está en features.md");

  assert.equal((await pedir("POST", "/otra")).codigo, 404);
  assert.equal((await pedir("GET", "/trabajos/99")).codigo, 404);
  assert.equal((await pedir("PUT", "/trabajos/1")).codigo, 405);
});
