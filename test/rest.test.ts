// Adaptador REST: rutas → casos de uso con Corridas y Features falsas, sobre un servidor real.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, before, after, test } from "node:test";
import { Rest } from "../src/adaptadores/entrada/rest.ts";
import { CorridaCancelada, Rechazo, type Corridas } from "../src/nucleo/corridas.ts";
import type { Features } from "../src/nucleo/features.ts";

const llamadas: { caso: string; opciones: unknown }[] = [];
/** Cada caso de uso queda abierto hasta que el test lo suelta o lo cancela. */
const abiertos: (() => void)[] = [];
const soltarTodo = () => abiertos.splice(0).forEach((f) => f());

const caso = (nombre: string) => async (opciones: unknown, aviso: unknown, signal?: AbortSignal) => {
  llamadas.push({ caso: nombre, opciones });
  const s = (typeof aviso === "function" ? signal : (aviso as AbortSignal))!;
  if (typeof aviso === "function") aviso('"construyendo"');
  if ((opciones as { id?: string }).id === "inexistente") throw new Rechazo("no está en features.md");
  await new Promise<void>((resolve, reject) => {
    abiertos.push(resolve);
    s.addEventListener("abort", () => reject(new CorridaCancelada()), { once: true });
  });
  return { ok: nombre };
};

const corridas = { interna: caso("interna"), externa: caso("externa") } as unknown as Corridas;
const features = { checks: caso("checks"), aprobar: caso("aprobar"), mejorar: caso("mejorar") } as unknown as Features;

let servidor: Server;
let base: string;

before(async () => {
  servidor = createServer(new Rest(corridas, features, 3).manejador());
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

// Cada test deja todo terminado para el siguiente.
afterEach(async () => {
  soltarTodo();
  for (const t of (await pedir("GET", "/trabajos")).cuerpo) await esperar(t.url, t.estado === "corriendo" ? "terminado" : t.estado);
});

test("REST: trabajo asíncrono con avisos y salida", async () => {
  const r = await pedir("POST", "/corridas/interna", { iteraciones: 3, topeUsd: "2" });
  assert.equal(r.codigo, 202);
  assert.match(r.ubicacion!, /^\/trabajos\/\d+$/);
  assert.equal(r.cuerpo.estado, "corriendo");
  const opciones = llamadas.at(-1)!.opciones as { etiqueta: string };
  assert.deepEqual(opciones, { etiqueta: opciones.etiqueta, iteraciones: 3, minutos: 15, topeUsd: 2 });

  soltarTodo();
  const fin = await esperar(r.ubicacion!, "terminado");
  assert.deepEqual(fin.salida, { ok: "interna" });
  assert.equal(fin.avisos[0].estado, '"construyendo"');
  assert.equal(fin.ruta, "POST /corridas/interna");
  assert.equal(fin.recurso, "corridas");
});

test("REST: features en paralelo; 409 sobre el mismo recurso y 429 al superar la concurrencia", async () => {
  const a = await pedir("POST", "/features/login/aprobar", { repo: "/r", rondas: 2 });
  const b = await pedir("POST", "/features/pago/checks", { repo: "/r" });
  const m = await pedir("POST", "/features/mejorar", { repo: "/r" });
  assert.deepEqual([a.codigo, b.codigo, m.codigo], [202, 202, 202]);
  assert.deepEqual(llamadas.slice(-3), [
    { caso: "aprobar", opciones: { repo: "/r", id: "login", rondas: 2, topeUsd: Infinity } },
    { caso: "checks", opciones: { repo: "/r", id: "pago" } },
    { caso: "mejorar", opciones: { repo: "/r" } },
  ]);

  // La misma feature (aunque se pida con otra acción) y el mismo repo para mejorar: 409.
  const mismaFeature = await pedir("POST", "/features/login/checks", { repo: "/r/" });
  assert.equal(mismaFeature.codigo, 409);
  assert.equal(mismaFeature.cuerpo.trabajo, a.ubicacion);
  assert.equal((await pedir("POST", "/features/mejorar", { repo: "/r/." })).codigo, 409);

  // Tres corriendo con concurrencia 3: el cuarto, aunque sea otro recurso, es 429.
  const cuarto = await pedir("POST", "/features/otra/checks", { repo: "/r" });
  assert.equal(cuarto.codigo, 429);

  // Cancelar uno libera lugar.
  const cancelado = await pedir("DELETE", a.ubicacion!);
  assert.equal(cancelado.cuerpo.estado, "cancelado");
  assert.equal((await pedir("POST", "/features/otra/checks", { repo: "/r" })).codigo, 202);
});

test("REST: las corridas son exclusivas entre sí", async () => {
  assert.equal((await pedir("POST", "/corridas/interna")).codigo, 202);
  const externa = await pedir("POST", "/corridas/externa");
  assert.equal(externa.codigo, 409);
  assert.match(externa.cuerpo.error, /corridas/);
  assert.equal((await pedir("POST", "/features/login/checks")).codigo, 202); // otra cosa sí corre
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
