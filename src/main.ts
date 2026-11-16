// Punto de entrada único. Elige el adaptador de entrada:
//   node src/main.ts servir [--puerto 8787]   → REST (src/adaptadores/entrada/rest.ts)
//   node src/main.ts <comando> ...            → consola (src/adaptadores/entrada/consola.ts);
//                                               sin argumentos imprime el uso.
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { Consola, USO } from "./adaptadores/entrada/consola.ts";
import { Rest } from "./adaptadores/entrada/rest.ts";
import { entero } from "./adaptadores/entrada/validacion.ts";
import { corridas, features } from "./composicion.ts";

// Los agentes corren en su propio grupo de procesos, así que Ctrl-C no les llega: la señal
// aborta la corrida (o cada trabajo del servidor) y cada adaptador mata su grupo.
const corte = new AbortController();
process.once("SIGINT", () => corte.abort());
process.once("SIGTERM", () => corte.abort());

const [comando, ...resto] = process.argv.slice(2);

if (comando === "servir") {
  let puerto: number;
  try {
    const { values } = parseArgs({ args: resto, options: { puerto: { type: "string" } } });
    puerto = entero("puerto", values.puerto, 8787);
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USO}`);
    process.exit(2);
  }
  // Solo 127.0.0.1: no hay autenticación y cada trabajo llama a `claude -p` y consume cuota.
  const rest = new Rest(corridas, features);
  const servidor = createServer(rest.manejador());
  corte.signal.addEventListener("abort", () => {
    rest.cancelarTodo();
    servidor.close();
    servidor.closeAllConnections();
  });
  servidor.listen(puerto, "127.0.0.1", () => console.log(`karpathy-loop REST en http://127.0.0.1:${puerto}`));
} else {
  process.exitCode = await new Consola(corridas, features, console).codigo(process.argv.slice(2), corte.signal);
}
