// Las dos máquinas con agentes, checks y entrenamiento falsos; git y las bitácoras son reales.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActor, toPromise } from "xstate";
import { BitacoraTsv } from "../src/adaptadores/bitacora-tsv.ts";
import { RepositorioGit } from "../src/adaptadores/repositorio-git.ts";
import { crearMaquinaExterna, ENCABEZADO_HISTORIAL } from "../src/nucleo/externo.ts";
import { crearMaquinaInterna, ENCABEZADO_RESULTADOS } from "../src/nucleo/interno.ts";
import { FalloDeAgente, type Agente, type Checks, type Encargo, type Entrenador } from "../src/nucleo/puertos.ts";

const PROGRAMA = "# programa\nGANANCIA=0.1\n<!-- protegido -->\nreglas\n<!-- fin protegido -->\n";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoDePrueba(): string {
  const raiz = mkdtempSync(join(tmpdir(), "karpathy-loop-"));
  git(raiz, "init", "-q");
  git(raiz, "config", "user.email", "test@example.com");
  git(raiz, "config", "user.name", "test");
  writeFileSync(join(raiz, "train.py"), "print('base')\n");
  writeFileSync(join(raiz, "program.md"), PROGRAMA);
  writeFileSync(join(raiz, "meta-prompt.md"), "# meta\n");
  writeFileSync(join(raiz, ".gitignore"), "results.tsv\nrun.log\nmeta/\n.trabajo/\n");
  git(raiz, "add", "-A");
  git(raiz, "commit", "-qm", "base");
  return raiz;
}

const filas = (ruta: string) =>
  readFileSync(ruta, "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));

/** Agente falso: una función por fase, que edita el directorio del encargo. */
const agenteFalso = (fases: Partial<Record<Encargo["fase"], (e: Encargo) => [string, number]>>): Agente => ({
  async respuesta(encargo) {
    const [texto, costoUsd] = fases[encargo.fase]!(encargo);
    return { texto, costoUsd };
  },
});

test("loop interno: write checks → build → pass checks; conserva, revierte, reintenta y rechaza", async () => {
  const dir = repoDePrueba();
  let n = 0;
  const fallos: string[] = [];
  const agente = agenteFalso({
    checks: (e) => {
      n++;
      mkdirSync(join(e.cwd, "checks"), { recursive: true });
      writeFileSync(join(e.cwd, "checks", `c${n}.py`), `# check ${n}\n`);
      if (n === 3) appendFileSync(join(e.cwd, "train.py"), "# antes de tiempo\n"); // fuera de alcance
      return [`pensando...\ncambio ${n}`, 1];
    },
    build: (e) => {
      if (e.prompt.includes("assert falló")) fallos.push(e.prompt); // reintento con la salida
      appendFileSync(join(e.cwd, "train.py"), `# cambio ${n}\n`);
      if (n === 4) appendFileSync(join(e.cwd, "checks", "c4.py"), "# debilitado\n"); // toca los checks
      return ["listo", 0.5];
    },
  });
  // Iteraciones 1, 2 y 7 pasan; la 5 pasa al tercer intento; la 6 agota los intentos.
  const resultados = [true, true, false, false, true, false, false, false, true];
  const checks: Checks = {
    async resultado() {
      const ok = resultados.shift()!;
      return { ok, salida: ok ? "" : "assert falló" };
    },
  };
  const valores: (number | Error)[] = [1.0, 0.9, 0.95, new Error("crash"), 0.8];
  const entrenador: Entrenador = {
    async medicion() {
      const v = valores.shift()!;
      if (v instanceof Error) throw v;
      return { valLoss: v };
    },
  };

  const tsv = join(dir, "results.tsv");
  const actor = createActor(crearMaquinaInterna({ agente, checks, entrenador }), {
    input: {
      repositorio: new RepositorioGit(dir),
      bitacora: new BitacoraTsv(tsv, ENCABEZADO_RESULTADOS),
      programa: PROGRAMA,
      maxIteraciones: 7,
      minutos: 5,
    },
  });
  actor.start();
  const salida = await toPromise(actor);

  // 7 escrituras de checks a 1 + 10 construcciones a 0.5 (1, 1, 1, 3, 3, 1).
  assert.deepEqual(salida, { lineaBase: 1.0, mejor: 0.8, iteraciones: 7, costoUsd: 12 });
  assert.deepEqual(
    filas(tsv).map((f) => [f[2], f[3]]),
    [
      ["keep", "linea base"],
      ["keep", "cambio 1"],
      ["discard", "cambio 2"],
      ["fuera_de_alcance", "cambio 3"],
      ["fuera_de_alcance", "cambio 4"],
      ["crash", "cambio 5"],
      ["checks_fallidos", "cambio 6"],
      ["keep", "cambio 7"],
    ],
  );
  assert.equal(fallos.length, 4); // 2 reintentos en la iteración 5 y 2 en la 6
  const codigo = readFileSync(join(dir, "train.py"), "utf8");
  assert.match(codigo, /cambio 1/);
  assert.match(codigo, /cambio 7/);
  assert.doesNotMatch(codigo, /cambio [2-6]|antes de tiempo/);
  assert.deepEqual(git(dir, "ls-files", "checks").split("\n"), ["checks/c1.py", "checks/c7.py"]);
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "3"); // base + 2 keep
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("loop externo: conserva el program.md que rinde más y bloquea el bloque protegido", async () => {
  const raiz = repoDePrueba();
  const cambiosMeta = [
    (p: string) => p.replace("GANANCIA=0.1", "GANANCIA=0.3"), // mejor: se conserva
    (p: string) => p.replace("GANANCIA=0.3", "GANANCIA=0.05"), // peor: se descarta
    (p: string) => p.replace("reglas", "sin reglas"), // toca lo protegido: se revierte
  ];
  const agente = agenteFalso({
    checks: (e) => {
      mkdirSync(join(e.cwd, "checks"), { recursive: true });
      writeFileSync(join(e.cwd, "checks", "c.py"), "# check\n");
      return ["cambio", 0];
    },
    build: (e) => {
      appendFileSync(join(e.cwd, "train.py"), "# cambio\n");
      return ["listo", 0];
    },
    programa: (e) => {
      const ruta = join(e.cwd, "program.md");
      writeFileSync(ruta, cambiosMeta.shift()!(readFileSync(ruta, "utf8")));
      return ["cambio al programa", 0.5];
    },
  });
  const checks: Checks = { resultado: async () => ({ ok: true, salida: "" }) };
  // El falso entrenamiento rinde según la GANANCIA escrita en el program.md vigente.
  const entrenador: Entrenador = {
    async medicion(dir) {
      const base = !readFileSync(join(dir, "train.py"), "utf8").includes("# cambio");
      const g = Number(readFileSync(join(raiz, "program.md"), "utf8").match(/GANANCIA=(\S+)/)![1]);
      return { valLoss: base ? 1.0 : 1.0 - g };
    },
  };

  const meta = join(raiz, "meta");
  const maquina = crearMaquinaExterna({
    agente,
    checks,
    entrenador,
    repositorio: new RepositorioGit(raiz),
    historial: new BitacoraTsv(join(meta, "historial.tsv"), ENCABEZADO_HISTORIAL),
    resultados: (v) => new BitacoraTsv(join(meta, `resultados-v${v}.tsv`), ENCABEZADO_RESULTADOS),
  });
  const actor = createActor(maquina, {
    input: {
      base: git(raiz, "rev-parse", "HEAD"),
      prefijo: "t",
      versiones: 4,
      iteracionesPorTanda: 1,
      minutosPorTanda: 5,
    },
  });
  actor.start();
  const salida = await toPromise(actor);

  assert.deepEqual(
    salida.historial.map((h) => [h.version, Number(h.ganancia.toFixed(2)), h.estado]),
    [
      [1, 0.1, "conservar"],
      [2, 0.3, "conservar"],
      [3, 0.05, "descartar"],
      [4, 0.3, "descartar"], // corrió con el v2: el cambio al bloque protegido se revirtió
    ],
  );
  assert.equal(salida.costoUsd, 1.5);
  assert.equal(filas(join(meta, "historial.tsv")).length, 4);
  assert.deepEqual(filas(join(meta, "resultados-v1.tsv")).map((f) => f[2]), ["keep", "keep"]);
  const programa = readFileSync(join(raiz, "program.md"), "utf8");
  assert.match(programa, /GANANCIA=0\.3/);
  assert.match(programa, /\nreglas\n/);
  assert.match(git(raiz, "log", "--oneline", "--", "program.md"), /program\.md v2/);
  assert.equal(git(raiz, "status", "--porcelain"), "");
  assert.equal(git(raiz, "worktree", "list").split("\n").length, 1); // se quitaron los worktrees
});

/** Máquina interna con checks que pasan y entrenamiento fijo; el agente lo pone cada test. */
function internaCon(agente: Agente, dir: string, extra: { maxIteraciones?: number } = {}) {
  const checks: Checks = { resultado: async () => ({ ok: true, salida: "" }) };
  const entrenador: Entrenador = { medicion: async () => ({ valLoss: 1.0 }) };
  const tsv = join(dir, "results.tsv");
  const actor = createActor(crearMaquinaInterna({ agente, checks, entrenador }), {
    input: {
      repositorio: new RepositorioGit(dir),
      bitacora: new BitacoraTsv(tsv, ENCABEZADO_RESULTADOS),
      programa: PROGRAMA,
      maxIteraciones: extra.maxIteraciones ?? 1,
      minutos: 5,
    },
  });
  return { actor, tsv };
}

test("loop interno: el costo de una llamada fallida se suma", async () => {
  const dir = repoDePrueba();
  const agente: Agente = {
    async respuesta() {
      throw new FalloDeAgente("error_max_budget_usd", 2);
    },
  };
  const { actor } = internaCon(agente, dir);
  actor.start();
  assert.equal((await toPromise(actor)).costoUsd, 2);
});
