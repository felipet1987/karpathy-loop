// Las dos máquinas con actores falsos: sin agentes reales ni entrenamiento.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createActor, fromPromise, toPromise } from "xstate";
import { maquinaExterna } from "../src/externo.ts";
import { git } from "../src/git.ts";
import { maquinaInterna, type EntradaProponer, type Propuesta } from "../src/interno.ts";

const PROGRAMA = "# programa\nGANANCIA=0.1\n<!-- protegido -->\nreglas\n<!-- fin protegido -->\n";

function repoDePrueba(): string {
  const raiz = mkdtempSync(join(tmpdir(), "karpathy-loop-"));
  git(raiz, "init", "-q");
  git(raiz, "config", "user.email", "test@example.com");
  git(raiz, "config", "user.name", "test");
  writeFileSync(join(raiz, "train.py"), "print('base')\n");
  writeFileSync(join(raiz, "program.md"), PROGRAMA);
  writeFileSync(join(raiz, ".gitignore"), "results.tsv\nrun.log\nmeta/\n.trabajo/\n");
  git(raiz, "add", "-A");
  git(raiz, "commit", "-qm", "base");
  return raiz;
}

const filas = (dir: string) =>
  readFileSync(join(dir, "results.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));

test("loop interno: conserva, revierte, rechaza fuera de alcance y registra crashes", async () => {
  const dir = repoDePrueba();
  let n = 0;
  const proponer = fromPromise<Propuesta, EntradaProponer>(async ({ input }) => {
    n++;
    appendFileSync(join(input.dir, "train.py"), `# cambio ${n}\n`);
    if (n === 3) writeFileSync(join(input.dir, "otro.txt"), "no permitido");
    return { descripcion: `cambio ${n}`, costoUsd: 0.01 };
  });
  const valores: (number | Error)[] = [1.0, 0.9, 0.95, new Error("crash"), 0.8];
  const entrenar = fromPromise<{ valLoss: number }, { dir: string }>(async () => {
    const v = valores.shift()!;
    if (v instanceof Error) throw v;
    return { valLoss: v };
  });

  const actor = createActor(maquinaInterna.provide({ actors: { proponer, entrenar } }), {
    input: { dir, rutaPrograma: join(dir, "program.md"), maxIteraciones: 5, minutos: 5 },
  });
  actor.start();
  const salida = await toPromise(actor);

  assert.deepEqual(salida, { lineaBase: 1.0, mejor: 0.8, iteraciones: 5, costoUsd: 0.05 });
  assert.deepEqual(
    filas(dir).map((f) => f[2]),
    ["keep", "keep", "discard", "fuera_de_alcance", "crash", "keep"],
  );
  const codigo = readFileSync(join(dir, "train.py"), "utf8");
  assert.match(codigo, /cambio 1/);
  assert.match(codigo, /cambio 5/);
  assert.doesNotMatch(codigo, /cambio [234]/);
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "3"); // base + 2 keep
  assert.equal(git(dir, "status", "--porcelain"), ""); // otro.txt se limpió
});

test("loop externo: conserva el program.md que rinde más y bloquea el bloque protegido", async () => {
  const raiz = repoDePrueba();
  // El falso entrenamiento rinde según la GANANCIA escrita en el program.md vigente.
  const entrenar = fromPromise<{ valLoss: number }, { dir: string }>(async ({ input }) => {
    const base = !readFileSync(join(input.dir, "train.py"), "utf8").includes("# cambio");
    const g = Number(readFileSync(join(raiz, "program.md"), "utf8").match(/GANANCIA=(\S+)/)![1]);
    return { valLoss: base ? 1.0 : 1.0 - g };
  });
  const proponer = fromPromise<Propuesta, EntradaProponer>(async ({ input }) => {
    appendFileSync(join(input.dir, "train.py"), "# cambio\n");
    return { descripcion: "cambio", costoUsd: 0 };
  });
  const cambiosMeta = [
    (p: string) => p.replace("GANANCIA=0.1", "GANANCIA=0.3"), // mejor: se conserva
    (p: string) => p.replace("GANANCIA=0.3", "GANANCIA=0.05"), // peor: se descarta
    (p: string) => p.replace("reglas", "sin reglas"), // toca lo protegido: se revierte
  ];
  const proponerPrograma = fromPromise<{ costoUsd: number }, { raiz: string }>(async ({ input }) => {
    const ruta = join(input.raiz, "program.md");
    writeFileSync(ruta, cambiosMeta.shift()!(readFileSync(ruta, "utf8")));
    return { costoUsd: 0.5 };
  });

  const maquina = maquinaExterna.provide({
    actors: { interno: maquinaInterna.provide({ actors: { proponer, entrenar } }), proponerPrograma },
  });
  const actor = createActor(maquina, {
    input: {
      raiz,
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
  const programa = readFileSync(join(raiz, "program.md"), "utf8");
  assert.match(programa, /GANANCIA=0\.3/);
  assert.match(programa, /\nreglas\n/);
  assert.match(git(raiz, "log", "--oneline", "--", "program.md"), /program\.md v2/);
  assert.equal(git(raiz, "status", "--porcelain"), "");
});
