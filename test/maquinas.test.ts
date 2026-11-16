// Las dos máquinas con agentes y checks falsos; git y las bitácoras son reales.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActor, toPromise } from "xstate";
import { BitacoraTsv } from "../src/adaptadores/bitacora-tsv.ts";
import { RepositorioGit } from "../src/adaptadores/repositorio-git.ts";
import { CorridaCancelada, crearCorridas, RepoConCambios } from "../src/nucleo/corridas.ts";
import { crearMaquinaExterna, ENCABEZADO_HISTORIAL } from "../src/nucleo/externo.ts";
import { crearMaquinaInterna, ENCABEZADO_RESULTADOS } from "../src/nucleo/interno.ts";
import { FalloDeAgente, type Agente, type Checks, type Encargo } from "../src/nucleo/puertos.ts";

const PROGRAMA = "# programa\nK=1\n<!-- protegido -->\nreglas\n<!-- fin protegido -->\n";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoDePrueba(): string {
  const raiz = mkdtempSync(join(tmpdir(), "karpathy-loop-"));
  git(raiz, "init", "-q");
  git(raiz, "config", "user.email", "test@example.com");
  git(raiz, "config", "user.name", "test");
  writeFileSync(join(raiz, "codigo.txt"), "base\n");
  writeFileSync(join(raiz, "program.md"), PROGRAMA);
  writeFileSync(join(raiz, "meta-prompt.md"), "# meta\n");
  writeFileSync(join(raiz, ".gitignore"), "results.tsv\nmeta/\n.trabajo/\n");
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

const escribirCheck = (e: Encargo, n: number) => {
  mkdirSync(join(e.cwd, "checks"), { recursive: true });
  writeFileSync(join(e.cwd, "checks", `c${n}.py`), `# check ${n}\n`);
};

const okSiempre: Checks = { resultado: async () => ({ ok: true, salida: "" }) };

test("loop interno: write checks → build → pass checks; conserva, reintenta y rechaza", async () => {
  const dir = repoDePrueba();
  let n = 0;
  const fallos: string[] = [];
  const agente = agenteFalso({
    checks: (e) => {
      n++;
      escribirCheck(e, n);
      if (n === 2) writeFileSync(join(e.cwd, "codigo.txt"), "antes de tiempo\n"); // fuera de alcance
      return [`pensando...\ncambio ${n}`, 1];
    },
    build: (e) => {
      if (e.prompt.includes("assert falló")) fallos.push(e.prompt); // reintento con la salida
      if (n !== 6) writeFileSync(join(e.cwd, "codigo.txt"), `cambio ${n}\n`); // la 6 no cambia nada
      if (n === 3) writeFileSync(join(e.cwd, "checks", "c3.py"), "# debilitado\n"); // toca los checks
      return ["listo", 0.5];
    },
  });
  // Corridas de checks: iteración 1 pasa; 4 pasa al tercer intento; 5 agota los intentos.
  const resultados = [true, false, false, true, false, false, false];
  const checks: Checks = {
    async resultado() {
      const ok = resultados.shift()!;
      return { ok, salida: ok ? "" : "assert falló" };
    },
  };

  const tsv = join(dir, "results.tsv");
  const actor = createActor(crearMaquinaInterna({ agente, checks }), {
    input: {
      repositorio: new RepositorioGit(dir),
      bitacora: new BitacoraTsv(tsv, ENCABEZADO_RESULTADOS),
      programa: PROGRAMA,
      maxIteraciones: 6,
      minutos: 5,
      topeUsd: Infinity,
    },
  });
  actor.start();
  const salida = await toPromise(actor);

  // 6 escrituras de checks a 1 + 9 construcciones a 0.5 (1, 0, 1, 3, 3, 1).
  assert.deepEqual(salida, { conservados: 2, iteraciones: 6, costoUsd: 10.5 });
  assert.deepEqual(
    filas(tsv).map((f) => [f[1], f[2]]),
    [
      ["keep", "cambio 1"],
      ["fuera_de_alcance", "cambio 2"],
      ["fuera_de_alcance", "cambio 3"],
      ["keep", "cambio 4"],
      ["checks_fallidos", "cambio 5"],
      ["fuera_de_alcance", "cambio 6"],
    ],
  );
  assert.equal(fallos.length, 4); // 2 reintentos en la iteración 4 y 2 en la 5
  assert.equal(readFileSync(join(dir, "codigo.txt"), "utf8"), "cambio 4\n");
  assert.deepEqual(git(dir, "ls-files", "checks").split("\n"), ["checks/c1.py", "checks/c4.py"]);
  assert.deepEqual(git(dir, "log", "--format=%s").split("\n"), ["cambio 4", "cambio 1", "base"]);
  assert.equal(filas(tsv)[0][0], git(dir, "rev-parse", "--short=7", "HEAD~1"));
  assert.equal(git(dir, "status", "--porcelain"), "");
});

/**
 * Agentes falsos del loop externo. El program.md trae `K=<n>`: el builder de cada tanda
 * hace pasar los checks en sus primeras K iteraciones y fallar en las demás.
 */
function agentesExterno(raiz: string, metas: ((programa: string) => string)[]) {
  let tanda = "";
  let construidas = 0;
  let n = 0;
  const agente = agenteFalso({
    checks: (e) => {
      n++;
      escribirCheck(e, n);
      return [`cambio ${n}`, 0.1];
    },
    build: (e) => {
      if (e.cwd !== tanda) [tanda, construidas] = [e.cwd, 0];
      const k = Number(e.systemPrompt.match(/K=(\d+)/)![1]);
      construidas++;
      writeFileSync(join(e.cwd, "codigo.txt"), `${construidas <= k ? "pasa" : "falla"} ${n}\n`);
      return ["listo", 0.1];
    },
    programa: () => {
      const ruta = join(raiz, "program.md");
      writeFileSync(ruta, metas.shift()!(readFileSync(ruta, "utf8")));
      return ["nueva versión", 0.5];
    },
  });
  // Pasan si el builder escribió "pasa"; los reintentos repiten lo mismo y vuelven a fallar.
  const checks: Checks = {
    async resultado(dir) {
      const ok = readFileSync(join(dir, "codigo.txt"), "utf8").startsWith("pasa");
      if (!ok) construidas++;
      return { ok, salida: ok ? "" : "falla" };
    },
  };
  return { agente, checks };
}

function externoCon(raiz: string, agente: Agente, checks: Checks, versiones: number) {
  const meta = join(raiz, "meta");
  const actor = createActor(
    crearMaquinaExterna({
      agente,
      checks,
      repositorio: new RepositorioGit(raiz),
      historial: new BitacoraTsv(join(meta, "historial.tsv"), ENCABEZADO_HISTORIAL),
      resultados: (v) => new BitacoraTsv(join(meta, `resultados-v${v}.tsv`), ENCABEZADO_RESULTADOS),
    }),
    {
      input: {
        base: git(raiz, "rev-parse", "--short=7", "HEAD"),
        prefijo: "t",
        versiones,
        iteracionesPorTanda: 3,
        minutosPorTanda: 5,
        topeUsdPorTanda: Infinity,
      },
    },
  );
  actor.start();
  return toPromise(actor);
}

test("loop externo: conserva el program.md que mejora y bloquea el bloque protegido", async () => {
  const raiz = repoDePrueba();
  const { agente, checks } = agentesExterno(raiz, [
    (p) => p.replace("K=1", "K=0"), // v2: peor
    (p) => p.replace("K=1", "K=3"), // v3: mejor (parte de v1, porque v2 se restauró)
    (p) => p.replace("reglas", "sin reglas").replace("K=3", "K=9"), // v4: toca el bloque protegido
  ]);
  const salida = await externoCon(raiz, agente, checks, 4);

  assert.deepEqual(salida.historial, [
    { version: 1, conservados: 1, estado: "mejora" },
    { version: 2, conservados: 0, estado: "sin_mejora" },
    { version: 3, conservados: 3, estado: "mejora" },
    { version: 4, conservados: 3, estado: "sin_mejora" }, // se restauró v3 antes de correr
  ]);
  assert.equal(salida.mejorConservados, 3);
  assert.deepEqual(
    filas(join(raiz, "meta", "historial.tsv")),
    [
      ["v1", "1", "mejora"],
      ["v2", "0", "sin_mejora"],
      ["v3", "3", "mejora"],
      ["v4", "3", "sin_mejora"],
    ],
  );
  const programa = readFileSync(join(raiz, "program.md"), "utf8");
  assert.match(programa, /K=3/);
  assert.match(programa, /\nreglas\n/);
  assert.equal(git(raiz, "log", "--format=%s", "-1"), "program.md v3: mejora, 3 conservados");
  assert.equal(git(raiz, "status", "--porcelain"), "");
  assert.equal(git(raiz, "worktree", "list").split("\n").length, 1);
});

/** Arma la máquina interna sobre un repo de prueba; devuelve el actor y la ruta del TSV. */
function internaCon(agente: Agente, dir = repoDePrueba(), topeUsd = Infinity, maxIteraciones = 3) {
  const tsv = join(dir, "results.tsv");
  const actor = createActor(crearMaquinaInterna({ agente, checks: okSiempre }), {
    input: {
      repositorio: new RepositorioGit(dir),
      bitacora: new BitacoraTsv(tsv, ENCABEZADO_RESULTADOS),
      programa: PROGRAMA,
      maxIteraciones,
      minutos: 5,
      topeUsd,
    },
  });
  return { actor, tsv };
}

test("loop interno: un fallo del agente suma su costo y deja fila fallo_agente", async () => {
  const agente: Agente = {
    async respuesta() {
      throw new FalloDeAgente("claude -p error_max_budget_usd", 0.7);
    },
  };
  const { actor, tsv } = internaCon(agente, undefined, Infinity, 2);
  actor.start();
  const salida = await toPromise(actor);
  assert.equal(salida.costoUsd, 1.4);
  assert.deepEqual(
    filas(tsv).map((f) => [f[1], f[2]]),
    [
      ["fallo_agente", "claude -p error_max_budget_usd"],
      ["fallo_agente", "claude -p error_max_budget_usd"],
    ],
  );
});

test("loop interno: se detiene al alcanzar el tope de USD", async () => {
  let n = 0;
  const agente = agenteFalso({
    checks: (e) => {
      escribirCheck(e, ++n);
      return [`cambio ${n}`, 1];
    },
    build: (e) => {
      writeFileSync(join(e.cwd, "codigo.txt"), `cambio ${n}\n`);
      return ["listo", 1];
    },
  });
  const { actor } = internaCon(agente, undefined, 3, 10);
  actor.start();
  const salida = await toPromise(actor);
  assert.equal(salida.iteraciones, 2); // 2 USD tras la primera, 4 tras la segunda: corta
  assert.equal(salida.costoUsd, 4);
});

test("loop externo: si el interno falla, quita el worktree y la tanda queda sin mejora", async () => {
  const raiz = repoDePrueba();
  const rota = {
    anotar() {
      throw new Error("disco lleno");
    },
    texto: () => "",
  };
  const agente = agenteFalso({
    checks: (e) => {
      escribirCheck(e, 1);
      return ["cambio", 0];
    },
    build: (e) => {
      writeFileSync(join(e.cwd, "codigo.txt"), "cambio\n");
      return ["listo", 0];
    },
  });
  const salida = await toPromise(
    createActor(
      crearMaquinaExterna({
        agente,
        checks: okSiempre,
        repositorio: new RepositorioGit(raiz),
        historial: new BitacoraTsv(join(raiz, "meta", "historial.tsv"), ENCABEZADO_HISTORIAL),
        resultados: () => rota,
      }),
      {
        input: {
          base: git(raiz, "rev-parse", "HEAD"),
          prefijo: "t",
          versiones: 1,
          iteracionesPorTanda: 1,
          minutosPorTanda: 5,
          topeUsdPorTanda: Infinity,
        },
      },
    ).start(),
  );
  assert.deepEqual(salida.historial, [{ version: 1, conservados: 0, estado: "sin_mejora" }]);
  assert.equal(git(raiz, "worktree", "list").split("\n").length, 1);
});

test("loop interno: detener la máquina aborta el signal del agente en curso", async () => {
  let recibido: AbortSignal | undefined;
  const agente: Agente = {
    respuesta: (_encargo, signal) => {
      recibido = signal;
      return new Promise(() => {}); // nunca responde
    },
  };
  const { actor } = internaCon(agente);
  actor.start();
  for (let i = 0; i < 100 && !recibido; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(recibido?.aborted, false);
  actor.stop();
  assert.equal(recibido?.aborted, true);
});

function corridasDe(raiz: string, agente: Agente) {
  return crearCorridas({
    agente,
    checks: okSiempre,
    repositorio: new RepositorioGit(raiz),
    bitacoraDeCorrida: (w) => new BitacoraTsv(join(w.directorio(), "results.tsv"), ENCABEZADO_RESULTADOS),
    historial: new BitacoraTsv(join(raiz, "meta", "historial.tsv"), ENCABEZADO_HISTORIAL),
    resultados: (v) => new BitacoraTsv(join(raiz, "meta", `resultados-v${v}.tsv`), ENCABEZADO_RESULTADOS),
  });
}

const opcionesInterna = { etiqueta: "c", iteraciones: 1, minutos: 5, topeUsd: Infinity };

test("corridas: con el repo sucio no crea worktree y rechaza con RepoConCambios", async () => {
  const raiz = repoDePrueba();
  writeFileSync(join(raiz, "suelto.txt"), "x");
  const corridas = corridasDe(raiz, agenteFalso({}));
  await assert.rejects(corridas.interna(opcionesInterna, () => {}, new AbortController().signal), RepoConCambios);
  assert.equal(git(raiz, "worktree", "list").split("\n").length, 1);
});

test("corridas: interna crea el worktree, avisa estados y devuelve la salida", async () => {
  const raiz = repoDePrueba();
  const estados: string[] = [];
  const agente: Agente = {
    async respuesta() {
      throw new FalloDeAgente("sin cuota en el test", 0);
    },
  };
  const salida = await corridasDe(raiz, agente).interna(opcionesInterna, (e) => estados.push(e), new AbortController().signal);
  assert.equal(salida.iteraciones, 1);
  assert.deepEqual(estados.slice(0, 2), ['"escribiendoChecks"', '"terminado"']);
  assert.match(git(raiz, "worktree", "list"), /\.trabajo\/c /);
});

test("corridas: abortar detiene la máquina, aborta el agente y rechaza con CorridaCancelada", async () => {
  const raiz = repoDePrueba();
  let recibido: AbortSignal | undefined;
  const agente: Agente = {
    respuesta: (_e, signal) => {
      recibido = signal;
      return new Promise(() => {});
    },
  };
  const corte = new AbortController();
  const corrida = corridasDe(raiz, agente).interna(opcionesInterna, () => {}, corte.signal);
  for (let i = 0; i < 100 && !recibido; i++) await new Promise((r) => setTimeout(r, 10));
  corte.abort();
  await assert.rejects(corrida, CorridaCancelada);
  assert.equal(recibido?.aborted, true);
});
