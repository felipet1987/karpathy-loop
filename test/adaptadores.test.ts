// Adaptadores locales, sin cuota: ChecksUv necesita uv; ClaudeCli usa un binario falso.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BitacoraTsv } from "../src/adaptadores/bitacora-tsv.ts";
import { ChecksUv } from "../src/adaptadores/checks-uv.ts";
import { ClaudeCli } from "../src/adaptadores/claude-cli.ts";
import { SalidaRecortada } from "../src/adaptadores/salida-recortada.ts";
import { FalloDeAgente } from "../src/nucleo/puertos.ts";

const temporal = () => mkdtempSync(join(tmpdir(), "karpathy-adaptadores-"));

test("ChecksUv: pasa si todos salen con 0; si no, reporta cuál falló y por qué", async () => {
  const dir = temporal();
  mkdirSync(join(dir, "checks"));
  writeFileSync(join(dir, "checks", "a.py"), "assert 1 + 1 == 2\n");
  const checks = new ChecksUv(60_000);
  assert.equal((await checks.resultado(dir)).ok, true);

  writeFileSync(join(dir, "checks", "b.py"), 'assert False, "roto"\n');
  const r = await checks.resultado(dir);
  assert.equal(r.ok, false);
  assert.match(r.salida, /PASA checks\/a\.py/);
  assert.match(r.salida, /FALLA checks\/b\.py \(código 1\)/);
  assert.match(r.salida, /AssertionError: roto/);
});

test("ChecksUv: sin checks no pasa", async () => {
  assert.deepEqual(await new ChecksUv(60_000).resultado(temporal()), { ok: false, salida: "no hay checks en checks/" });
});

test("SalidaRecortada: deja los últimos N caracteres y respeta ok", async () => {
  const origen = { resultado: async () => ({ ok: false, salida: "0123456789" }) };
  assert.deepEqual(await new SalidaRecortada(origen, 4).resultado("."), { ok: false, salida: "6789" });
});

test("BitacoraTsv: crea carpeta y encabezado con la primera fila y limpia tabs", () => {
  const ruta = join(temporal(), "meta", "h.tsv");
  const bitacora = new BitacoraTsv(ruta, ["a", "b"]);
  assert.equal(bitacora.texto(), "");
  bitacora.anotar(["1", "x\ty\nz"]);
  assert.equal(bitacora.texto(), "a\tb\n1\tx y z\n");
});

test("ClaudeCli: con código ≠ 0 conserva el costo informado en el JSON", async () => {
  const dir = temporal();
  const binario = join(dir, "claude-falso");
  writeFileSync(
    binario,
    '#!/bin/sh\ncat > /dev/null\necho \'{"subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":1.5}\'\nexit 1\n',
    { mode: 0o755 },
  );
  const agente = new ClaudeCli(binario, "modelo", 1, 10_000);
  const encargo = { fase: "build" as const, systemPrompt: "s", prompt: "p", cwd: dir, herramientas: ["Read"] };
  await assert.rejects(agente.respuesta(encargo), (e) => e instanceof FalloDeAgente && e.costoUsd === 1.5);
});
