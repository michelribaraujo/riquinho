/* Monta o arquivo único que vai pro Cloudflare:
   index.html + dados-demo.js  →  embutidos dentro do worker-src.js  →  painel-worker.js */
import fs from "node:fs";

let html = fs.readFileSync("index.html", "utf8");
const demo = fs.readFileSync("dados-demo.js", "utf8");

// Na versão publicada o retrato de demonstração não vai junto: o painel lê o Organizze de verdade.
html = html.replace('<script src="dados-demo.js"></script>', "");

const escapado = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

let worker = fs.readFileSync("worker-src.js", "utf8");
worker = worker.replace("`__HTML_DO_PAINEL__`", "`" + escapado + "`");

fs.writeFileSync("painel-worker.js", worker);
console.log("painel-worker.js:", (worker.length / 1024).toFixed(0) + " KB");

// versão offline pra ele abrir agora, com o retrato embutido
const offline = fs.readFileSync("index.html", "utf8")
  .replace('<script src="dados-demo.js"></script>', "<script>" + demo + "</script>");
fs.writeFileSync("painel-preview.html", offline);
console.log("painel-preview.html:", (offline.length / 1024).toFixed(0) + " KB");
