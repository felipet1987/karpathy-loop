// Uso:
//   node src/cli.ts interno [--iteraciones 10] [--minutos 15] [--etiqueta nov13]
//   node src/cli.ts externo [--versiones 4] [--iteraciones 8] [--minutos 10] [--etiqueta nov13]
// Cada iteración llama a un agente real y consume cuota.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createActor, type AnyActorLogic } from "xstate";
import { maquinaExternaReal, maquinaInternaReal } from "./agentes.ts";
import { cambiados, crearWorktree, git } from "./git.ts";

const raiz = git(process.cwd(), "rev-parse", "--show-toplevel");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    iteraciones: { type: "string" },
    minutos: { type: "string" },
    versiones: { type: "string" },
    etiqueta: { type: "string", default: new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "") },
  },
});

if (cambiados(raiz).length > 0) {
  console.error("El repo tiene cambios sin commitear; las máquinas hacen checkout y los perderían.");
  process.exit(1);
}

async function correr(logica: AnyActorLogic, input: unknown) {
  const actor = createActor(logica, { input });
  let anterior = "";
  actor.subscribe((s) => {
    const estado = JSON.stringify(s.value);
    if (estado !== anterior) console.log(`[${new Date().toLocaleTimeString()}] ${estado}`);
    anterior = estado;
  });
  actor.start();
  const fin = await new Promise((resolve, reject) => {
    actor.subscribe({ complete: () => resolve(actor.getSnapshot().output), error: reject });
  });
  console.log(JSON.stringify(fin, null, 2));
}

const base = git(raiz, "rev-parse", "HEAD");
if (positionals[0] === "interno") {
  await correr(maquinaInternaReal, {
    dir: crearWorktree(raiz, values.etiqueta, base),
    rutaPrograma: join(raiz, "program.md"),
    maxIteraciones: Number(values.iteraciones ?? 10),
    minutos: Number(values.minutos ?? 15),
  });
} else if (positionals[0] === "externo") {
  await correr(maquinaExternaReal, {
    raiz,
    base,
    prefijo: values.etiqueta,
    versiones: Number(values.versiones ?? 4),
    iteracionesPorTanda: Number(values.iteraciones ?? 8),
    minutosPorTanda: Number(values.minutos ?? 10),
  });
} else {
  console.error("Uso: node src/cli.ts interno|externo [--iteraciones N] [--minutos N] [--versiones N] [--etiqueta X]");
  process.exit(2);
}
