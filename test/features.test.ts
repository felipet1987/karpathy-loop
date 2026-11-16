// Flujo por feature con agente falso; git, checks (scripts .sh) y registros son reales.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BitacoraTsv } from "../src/adaptadores/bitacora-tsv.ts";
import { ChecksPorArchivo } from "../src/adaptadores/checks-por-archivo.ts";
import { RepositorioGit } from "../src/adaptadores/repositorio-git.ts";
import { Rechazo } from "../src/nucleo/corridas.ts";
import { ENCABEZADO_RONDAS } from "../src/nucleo/feature.ts";
import { crearFeatures, idsDe } from "../src/nucleo/features.ts";
import type { Agente, Encargo } from "../src/nucleo/puertos.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoDePrueba(): string {
  const raiz = mkdtempSync(join(tmpdir(), "kl-feature-"));
  git(raiz, "init", "-q");
  git(raiz, "config", "user.email", "test@example.com");
  git(raiz, "config", "user.name", "test");
  writeFileSync(join(raiz, "features.md"), "# Features\n\n## saludo\nUn hola.sh que imprime hola y un LEEME.\n");
  writeFileSync(join(raiz, "program.md"), "# programa\n");
  writeFileSync(join(raiz, ".gitignore"), ".trabajo/\n.kl/\n");
  git(raiz, "add", "-A");
  git(raiz, "commit", "-qm", "base");
  return raiz;
}

type Fase = Encargo["fase"];
const agenteFalso = (fases: Partial<Record<Fase, (e: Encargo) => [string, number]>>): Agente => ({
  async respuesta(encargo) {
    const [texto, costoUsd] = fases[encargo.fase]!(encargo);
    return { texto, costoUsd };
  },
});

const escribirChecks = (e: Encargo): [string, number] => {
  const carpeta = join(e.cwd, "checks", "saludo");
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, "01-hola.sh"), 'test "$(bash hola.sh)" = hola\n');
  writeFileSync(join(carpeta, "02-leeme.sh"), "test -f LEEME\n");
  writeFileSync(join(carpeta, "notas.md"), "no es un check\n");
  return ["hola.sh y LEEME", 0.5];
};

function features(raiz: string, agente: Agente) {
  return crearFeatures({
    agente,
    evaluador: new ChecksPorArchivo(10_000, 500),
    repositorio: () => new RepositorioGit(raiz),
    rondas: (repo, id) => new BitacoraTsv(join(repo.directorio(), ".kl", "rondas", `${id}.tsv`), ENCABEZADO_RONDAS),
    reporte: (repo, id, texto) => {
      const ruta = join(repo.directorio(), ".kl", `${id}.md`);
      writeFileSync(ruta, texto);
      return ruta;
    },
  });
}

const nunca = new AbortController().signal;
const callado = () => {};

test("idsDe: cada título ## es una feature", () => {
  assert.deepEqual(idsDe("# F\n## uno\ntexto\n##  dos-2 \n### no\n"), ["uno", "dos-2"]);
});

test("feature: write-checks → revisión → approve-checks → rondas → reporte", async () => {
  const raiz = repoDePrueba();
  const prompts: string[] = [];
  let ronda = 0;
  const agente = agenteFalso({
    "write-checks": (e) => {
      assert.equal(e.prompt, "/kl:write-checks saludo");
      assert.equal(e.systemPrompt, "# programa\n");
      return escribirChecks(e);
    },
    "feature-builder": (e) => {
      prompts.push(e.prompt);
      ronda++;
      if (ronda === 1) writeFileSync(join(e.cwd, "checks", "saludo", "02-leeme.sh"), "true\n"); // debilita un check
      if (ronda === 3) writeFileSync(join(e.cwd, "hola.sh"), "echo hola\n");
      if (ronda === 4) writeFileSync(join(e.cwd, "hola.sh"), "echo chau\n"); // rompe lo que pasaba
      if (ronda === 5) writeFileSync(join(e.cwd, "LEEME"), "leeme\n");
      return [`ronda ${ronda}`, 1];
    },
  });
  const f = features(raiz, agente);

  // write-checks: quedan sin commitear para la persona.
  const escritos = await f.checks({ repo: raiz, id: "saludo" }, nunca);
  assert.equal(escritos.worktree, join(raiz, ".trabajo", "feature-saludo"));
  assert.deepEqual(escritos.archivos.sort(), [
    "checks/saludo/01-hola.sh",
    "checks/saludo/02-leeme.sh",
    "checks/saludo/notas.md",
  ]);
  assert.equal(git(escritos.worktree, "log", "--format=%s", "-1"), "base");

  // La persona ajusta un check antes de aprobar.
  writeFileSync(join(escritos.worktree, "checks", "saludo", "01-hola.sh"), 'test "$(bash hola.sh)" = "hola"\n');

  const estados: string[] = [];
  const salida = await f.aprobar({ repo: raiz, id: "saludo", rondas: 10, topeUsd: Infinity }, (s) => estados.push(s), nunca);
  assert.deepEqual(
    { ...salida, reporte: undefined },
    { id: "saludo", completa: true, puntaje: "2/2", rondas: 5, costoUsd: 5, reporte: undefined },
  );
  assert.ok(estados.includes('"corriendoChecks"'));

  const rondas = readFileSync(join(raiz, ".kl", "rondas", "saludo.tsv"), "utf8").trim().split("\n").slice(1);
  assert.deepEqual(
    rondas.map((l) => l.split("\t")).map(([r, , p, e, fallos]) => [r, p, e, fallos]),
    [
      ["0", "0/2", "base", "01-hola.sh,02-leeme.sh"],
      ["1", "-", "fuera_de_alcance", "-"],
      ["2", "-", "sin_cambios", "-"],
      ["3", "1/2", "conservado", "02-leeme.sh"],
      ["4", "0/2", "deshecho", "01-hola.sh,02-leeme.sh"],
      ["5", "2/2", "completa", ""],
    ],
  );
  // La salida de los checks que fallaron llega al builder de la ronda siguiente.
  assert.match(prompts[0], /^\/kl:feature-builder saludo\n\nSalida de los checks de la ronda anterior:\n\nFALLA 01-hola.sh/);
  assert.match(prompts[4], /FALLA 01-hola\.sh/);
  assert.deepEqual(git(escritos.worktree, "log", "--format=%s").split("\n"), [
    "saludo: ronda 5",
    "saludo: ronda 3",
    "checks aprobados: saludo",
    "base",
  ]);
  assert.equal(readFileSync(join(escritos.worktree, "checks", "saludo", "02-leeme.sh"), "utf8"), "test -f LEEME\n");
  assert.equal(readFileSync(join(escritos.worktree, "hola.sh"), "utf8"), "echo hola\n");
  assert.equal(git(escritos.worktree, "status", "--porcelain"), "");

  const reporte = readFileSync(salida.reporte, "utf8");
  assert.match(reporte, /Estado: completa/);
  assert.match(reporte, /\| 4 \| - \| 0\/2 \| deshecho \| 01-hola.sh,02-leeme.sh \| ronda 4 \|/);

  // Repetir checks sobre una feature aprobada se rechaza.
  await assert.rejects(f.checks({ repo: raiz, id: "saludo" }, nunca), /ya están aprobados/);
});

test("feature: rechazos de write-checks y approve-checks", async () => {
  const raiz = repoDePrueba();
  const f = features(
    raiz,
    agenteFalso({
      "write-checks": (e) => {
        escribirChecks(e);
        writeFileSync(join(e.cwd, "hola.sh"), "echo hola\n"); // código antes de tiempo
        return ["x", 0];
      },
    }),
  );
  await assert.rejects(f.checks({ repo: raiz, id: "otra" }, nunca), (e) => e instanceof Rechazo && /no está en features.md/.test(e.message));
  await assert.rejects(f.aprobar({ repo: raiz, id: "saludo", rondas: 1, topeUsd: 1 }, callado, nunca), /correr antes `feature checks saludo`/);
  await assert.rejects(f.checks({ repo: raiz, id: "saludo" }, nunca), /fuera de checks\/saludo\/: hola.sh/);
  const wt = join(raiz, ".trabajo", "feature-saludo");
  assert.equal(git(wt, "status", "--porcelain"), "");

  // La persona no puede aprobar con cambios fuera de la carpeta, ni sin checks.
  writeFileSync(join(wt, "otro.txt"), "x\n");
  await assert.rejects(f.aprobar({ repo: raiz, id: "saludo", rondas: 1, topeUsd: 1 }, callado, nunca), /fuera de checks\/saludo\/: otro.txt/);
  git(wt, "clean", "-fdq");
  await assert.rejects(f.aprobar({ repo: raiz, id: "saludo", rondas: 1, topeUsd: 1 }, callado, nunca), /No hay checks/);
});

test("feature: el tope de USD corta las rondas y la feature queda incompleta", async () => {
  const raiz = repoDePrueba();
  const f = features(
    raiz,
    agenteFalso({ "write-checks": escribirChecks, "feature-builder": () => ["nada", 3] }),
  );
  await f.checks({ repo: raiz, id: "saludo" }, nunca);
  const salida = await f.aprobar({ repo: raiz, id: "saludo", rondas: 10, topeUsd: 5 }, callado, nunca);
  assert.equal(salida.rondas, 2);
  assert.equal(salida.completa, false);
  assert.equal(salida.puntaje, "0/2");
  assert.match(readFileSync(salida.reporte, "utf8"), /Estado: incompleta/);
});

test("auto-loop: conserva un cambio a program.md y revierte si toca otra cosa", async () => {
  const raiz = repoDePrueba();
  let n = 0;
  const f = features(
    raiz,
    agenteFalso({
      "auto-loop": (e) => {
        assert.equal(e.prompt, "/kl:auto-loop");
        n++;
        writeFileSync(join(e.cwd, "program.md"), `# programa\nregla ${n}\n`);
        if (n === 2) writeFileSync(join(e.cwd, "features.md"), "borrado\n");
        return [`regla ${n}: hipótesis`, 0.2];
      },
    }),
  );
  writeFileSync(join(raiz, "suelto.txt"), "de la persona\n"); // cambio previo: no cuenta
  const primera = await f.mejorar({ repo: raiz }, nunca);
  assert.equal(primera.estado, "conservado");
  assert.equal(git(raiz, "log", "--format=%s", "-1"), "auto-loop: regla 1: hipótesis");

  const segunda = await f.mejorar({ repo: raiz }, nunca);
  assert.equal(segunda.estado, "revertido");
  assert.deepEqual(segunda.tocados.sort(), ["features.md", "program.md"]);
  assert.equal(readFileSync(join(raiz, "program.md"), "utf8"), "# programa\nregla 1\n");
  assert.match(readFileSync(join(raiz, "features.md"), "utf8"), /## saludo/);
  assert.ok(existsSync(join(raiz, "suelto.txt")));
});

test("features en paralelo: dos aprobar a la vez sobre el mismo repo no se pisan", async () => {
  const raiz = repoDePrueba();
  writeFileSync(join(raiz, "features.md"), "# F\n\n## uno\nArchivo UNO.\n\n## dos\nArchivo DOS.\n");
  git(raiz, "commit", "-qam", "dos features");
  const pausa = () => new Promise((r) => setTimeout(r, 5));
  const agente: Agente = {
    async respuesta(e) {
      await pausa(); // intercala las dos features entre llamadas
      const id = e.prompt.split(/\s/)[1];
      const nombreArchivo = id.toUpperCase();
      if (e.fase === "write-checks") {
        mkdirSync(join(e.cwd, "checks", id), { recursive: true });
        writeFileSync(join(e.cwd, "checks", id, "01.sh"), `test -f ${nombreArchivo}\n`);
        writeFileSync(join(e.cwd, "checks", id, "02.sh"), `grep -q listo ${nombreArchivo}\n`);
      } else {
        // Primera ronda: crea el archivo sin "listo" (1/2); segunda: lo completa (2/2).
        const ruta = join(e.cwd, nombreArchivo);
        writeFileSync(ruta, existsSync(ruta) ? "listo\n" : "a medias\n");
      }
      return { texto: `${e.fase} ${id}`, costoUsd: 0.1 };
    },
  };
  const f = features(raiz, agente);
  await Promise.all([f.checks({ repo: raiz, id: "uno" }, nunca), f.checks({ repo: raiz, id: "dos" }, nunca)]);
  const [uno, dos] = await Promise.all(
    ["uno", "dos"].map((id) => f.aprobar({ repo: raiz, id, rondas: 5, topeUsd: Infinity }, callado, nunca)),
  );
  for (const [s, id] of [[uno, "uno"], [dos, "dos"]] as const) {
    assert.deepEqual({ completa: s.completa, puntaje: s.puntaje, rondas: s.rondas }, { completa: true, puntaje: "2/2", rondas: 2 });
    const wt = join(raiz, ".trabajo", `feature-${id}`);
    assert.deepEqual(git(wt, "ls-files").split("\n").filter((r) => r !== ".gitignore" && !r.endsWith(".md")).sort(), [
      id.toUpperCase(),
      `checks/${id}/01.sh`,
      `checks/${id}/02.sh`,
    ]);
    assert.equal(git(wt, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(raiz, ".kl", "rondas", `${id}.tsv`), "utf8").trim().split("\n").length, 4); // encabezado + base + 2
  }
  assert.equal(git(raiz, "worktree", "list").split("\n").length, 3);
});
