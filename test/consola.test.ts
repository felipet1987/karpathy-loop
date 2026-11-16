// Adaptador de entrada: argumentos → casos de uso, y resultado → texto y código de salida.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Consola } from "../src/adaptadores/entrada/consola.ts";
import { CorridaCancelada, Rechazo, RepoConCambios, type Corridas } from "../src/nucleo/corridas.ts";
import type { Features } from "../src/nucleo/features.ts";

/** Corridas falsas que guardan lo que recibieron y responden lo que se les pida. */
function corridasFalsas(respuesta: () => Promise<unknown> = async () => ({ ok: true })) {
  const llamadas: { caso: string; opciones: unknown }[] = [];
  const corridas = {
    interna: async (opciones: unknown, aviso: (e: string) => void) => {
      llamadas.push({ caso: "interna", opciones });
      aviso('"lineaBase"');
      return respuesta();
    },
    externa: async (opciones: unknown) => {
      llamadas.push({ caso: "externa", opciones });
      return respuesta();
    },
  } as unknown as Corridas;
  const caso = (nombre: string) => async (opciones: unknown) => {
    llamadas.push({ caso: nombre, opciones });
    return respuesta();
  };
  const features = { checks: caso("checks"), aprobar: caso("aprobar"), mejorar: caso("mejorar") } as unknown as Features;
  return { corridas, features, llamadas };
}

function terminal() {
  const log: string[] = [];
  const error: string[] = [];
  return { log, error, t: { log: (s: string) => log.push(s), error: (s: string) => error.push(s) } };
}

const nunca = new AbortController().signal;

test("Consola: interno con valores por defecto, avisos y salida en JSON", async () => {
  const { corridas, features, llamadas } = corridasFalsas();
  const { log, t } = terminal();
  const codigo = await new Consola(corridas, features, t).codigo(["interno", "--etiqueta", "e1"], nunca);
  assert.equal(codigo, 0);
  assert.deepEqual(llamadas, [
    { caso: "interna", opciones: { etiqueta: "e1", iteraciones: 10, minutos: 15, topeUsd: Infinity } },
  ]);
  assert.match(log[0], /\] "lineaBase"$/);
  assert.deepEqual(JSON.parse(log.at(-1)!), { ok: true });
});

test("Consola: externo traduce los flags", async () => {
  const { corridas, features, llamadas } = corridasFalsas();
  const { t } = terminal();
  const args = ["externo", "--versiones", "2", "--iteraciones", "3", "--minutos", "1.5", "--tope-usd", "4", "--etiqueta", "x"];
  assert.equal(await new Consola(corridas, features, t).codigo(args, nunca), 0);
  assert.deepEqual(llamadas[0].opciones, {
    etiqueta: "x",
    versiones: 2,
    iteracionesPorTanda: 3,
    minutosPorTanda: 1.5,
    topeUsdPorTanda: 4,
  });
});

test("Consola: uso inválido sale con 2 sin llamar a ningún caso de uso", async () => {
  for (const args of [
    [],
    ["otro"],
    ["interno", "--iteraciones", "abc"],
    ["interno", "--iteraciones", "2.5"],
    ["interno", "--tope-usd", "-1"],
    ["interno", "--versiones", "2"],
    ["interno", "--etiqueta", "../fuera"],
    ["interno", "--desconocido"],
    ["interno", "--repo", "x"],
    ["feature"],
    ["feature", "otro", "x"],
    ["feature", "checks"],
    ["feature", "checks", "a", "b"],
    ["feature", "checks", "../x"],
    ["feature", "checks", ".x"],
    ["feature", "checks", "x", "--rondas", "2"],
    ["feature", "aprobar", "x", "--rondas", "0"],
    ["feature", "mejorar", "x"],
  ]) {
    const { corridas, features, llamadas } = corridasFalsas();
    const { error, t } = terminal();
    assert.equal(await new Consola(corridas, features, t).codigo(args, nunca), 2, args.join(" "));
    assert.equal(llamadas.length, 0);
    assert.match(error[0], /Uso:/);
  }
});

test("Consola: repo con cambios sale con 1 y una corrida cancelada con 130", async () => {
  for (const [error, codigo] of [
    [new RepoConCambios(), 1],
    [new Rechazo("no está en features.md"), 1],
    [new CorridaCancelada(), 130],
  ] as const) {
    const { corridas, features } = corridasFalsas(async () => {
      throw error;
    });
    const { error: errores, t } = terminal();
    assert.equal(await new Consola(corridas, features, t).codigo(["interno"], nunca), codigo);
    assert.equal(errores[0], error.message);
  }
});

test("Consola: feature checks, aprobar y mejorar", async () => {
  const { corridas, features, llamadas } = corridasFalsas();
  const { t } = terminal();
  const consola = new Consola(corridas, features, t);
  assert.equal(await consola.codigo(["feature", "checks", "login"], nunca), 0);
  assert.equal(await consola.codigo(["feature", "aprobar", "login", "--repo", "/r", "--rondas", "3", "--tope-usd", "2"], nunca), 0);
  assert.equal(await consola.codigo(["feature", "aprobar", "login"], nunca), 0);
  assert.equal(await consola.codigo(["feature", "mejorar", "--repo", "/r"], nunca), 0);
  assert.deepEqual(llamadas, [
    { caso: "checks", opciones: { repo: ".", id: "login" } },
    { caso: "aprobar", opciones: { repo: "/r", id: "login", rondas: 3, topeUsd: 2 } },
    { caso: "aprobar", opciones: { repo: ".", id: "login", rondas: 5, topeUsd: Infinity } },
    { caso: "mejorar", opciones: { repo: "/r" } },
  ]);
});
