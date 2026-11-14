// Adaptadores locales, sin cuota: ChecksUv y EntrenadorUv necesitan uv; ClaudeCli usa un binario falso.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BitacoraTsv } from "../src/adaptadores/bitacora-tsv.ts";
import { ChecksUv } from "../src/adaptadores/checks-uv.ts";
import { ClaudeCli } from "../src/adaptadores/claude-cli.ts";
import { EntrenadorUv } from "../src/adaptadores/entrenador-uv.ts";
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
  await assert.rejects(agente.respuesta(encargo, new AbortController().signal), (e) => e instanceof FalloDeAgente && e.costoUsd === 1.5);
});

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera a que exista el archivo con el pid del nieto y lo devuelve. */
async function pidDelNieto(ruta: string): Promise<number> {
  for (let i = 0; i < 200 && !existsSync(ruta); i++) await pausa(50);
  for (let i = 0; i < 20 && !readFileSync(ruta, "utf8").trim(); i++) await pausa(50);
  return Number(readFileSync(ruta, "utf8"));
}

const vivo = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("ClaudeCli: al abortar mata al proceso y a sus nietos", async () => {
  const dir = temporal();
  const binario = join(dir, "claude-colgado");
  writeFileSync(binario, `#!/bin/sh\nsleep 30 &\necho $! > ${join(dir, "pid")}\nwait\n`, { mode: 0o755 });
  const agente = new ClaudeCli(binario, "modelo", 1, 60_000);
  const corte = new AbortController();
  const encargo = { fase: "build" as const, systemPrompt: "s", prompt: "p", cwd: dir, herramientas: ["Read"] };
  const llamada = agente.respuesta(encargo, corte.signal);
  const nieto = await pidDelNieto(join(dir, "pid"));
  assert.equal(vivo(nieto), true);
  const inicio = Date.now();
  corte.abort();
  await assert.rejects(llamada, (e) => e instanceof FalloDeAgente && /cancelado/.test(e.message));
  // Si solo se matara al hijo, el nieto mantendría abierto el pipe y esto tardaría 30 s.
  assert.ok(Date.now() - inicio < 5_000, `tardó ${Date.now() - inicio} ms`);
  assert.equal(vivo(nieto), false);
});

test("EntrenadorUv: al vencer el plazo mata a uv y al python que lanzó", async () => {
  const dir = temporal();
  writeFileSync(
    join(dir, "train.py"),
    "import os, time\nopen('pid', 'w').write(str(os.getpid()))\ntime.sleep(30)\n",
  );
  const inicio = Date.now();
  const medicion = new EntrenadorUv(3_000).medicion(dir, new AbortController().signal);
  const python = await pidDelNieto(join(dir, "pid"));
  await assert.rejects(medicion, /plazo/);
  // Si solo se matara a uv, python mantendría abierto el pipe y esto tardaría 30 s.
  assert.ok(Date.now() - inicio < 15_000, `tardó ${Date.now() - inicio} ms`);
  assert.equal(vivo(python), false);
});
