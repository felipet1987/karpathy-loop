// Adaptador de entrada: argumentos → casos de uso, y resultado → texto y código de salida.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Consola } from "../src/adaptadores/entrada/consola.ts";
import { CorridaCancelada, RepoConCambios, type Corridas } from "../src/nucleo/corridas.ts";

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
  return { corridas, llamadas };
}

function terminal() {
  const log: string[] = [];
  const error: string[] = [];
  return { log, error, t: { log: (s: string) => log.push(s), error: (s: string) => error.push(s) } };
}

const nunca = new AbortController().signal;

test("Consola: interno con valores por defecto, avisos y salida en JSON", async () => {
  const { corridas, llamadas } = corridasFalsas();
  const { log, t } = terminal();
  const codigo = await new Consola(corridas, t).codigo(["interno", "--etiqueta", "e1"], nunca);
  assert.equal(codigo, 0);
  assert.deepEqual(llamadas, [
    { caso: "interna", opciones: { etiqueta: "e1", iteraciones: 10, minutos: 15, topeUsd: Infinity } },
  ]);
  assert.match(log[0], /\] "lineaBase"$/);
  assert.deepEqual(JSON.parse(log.at(-1)!), { ok: true });
});

test("Consola: externo traduce los flags", async () => {
  const { corridas, llamadas } = corridasFalsas();
  const { t } = terminal();
  const args = ["externo", "--versiones", "2", "--iteraciones", "3", "--minutos", "1.5", "--tope-usd", "4", "--etiqueta", "x"];
  assert.equal(await new Consola(corridas, t).codigo(args, nunca), 0);
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
  ]) {
    const { corridas, llamadas } = corridasFalsas();
    const { error, t } = terminal();
    assert.equal(await new Consola(corridas, t).codigo(args, nunca), 2, args.join(" "));
    assert.equal(llamadas.length, 0);
    assert.match(error[0], /Uso:/);
  }
});

test("Consola: repo con cambios sale con 1 y una corrida cancelada con 130", async () => {
  for (const [error, codigo] of [
    [new RepoConCambios(), 1],
    [new CorridaCancelada(), 130],
  ] as const) {
    const { corridas } = corridasFalsas(async () => {
      throw error;
    });
    const { error: errores, t } = terminal();
    assert.equal(await new Consola(corridas, t).codigo(["interno"], nunca), codigo);
    assert.equal(errores[0], error.message);
  }
});
