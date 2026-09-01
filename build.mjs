/* Monta o arquivo único que vai pro Cloudflare:
   index.html + dados-demo.js  →  embutidos dentro do worker-src.js  →  painel-worker.js */
import fs from "node:fs";


/* ══════════════════════════════════════════════════════════════════
   GUARDA DE COLISÃO DE NOME

   Em uma semana eu quebrei este painel três vezes reusando um nome que
   já existia — e as três em silêncio, porque JS e CSS não reclamam:

     renderSelo()  a função nova calou a do selo de procedência do topo,
                   e o aviso de dado em cache simplesmente sumiu
     .face         as cartinhas do leque herdaram o fundo das cartas
                   grandes do baralho: verso e face na mesma cor
     .selo         o carimbo de mês carimbou `transform:rotate(-7deg)`
                   no chip do topo, que passou a aparecer TORTO na tela

   Atenção não resolve isso — processo resolve. Este bloco falha o build
   antes de gerar arquivo, listando o que colidiu.
   ══════════════════════════════════════════════════════════════════ */
function acusarColisoes(html) {
  const problemas = [];

  const css = (html.match(/<style>([\s\S]*?)<\/style>/g) || []).join("\n");
  const seletores = {};
  // só regras de classe simples no começo da linha: é onde a colisão dói
  for (const m of css.matchAll(/^\.([a-zA-Z][\w-]*)\s*\{/gm)) {
    (seletores[m[1]] = seletores[m[1]] || []).push(m.index);
  }
  for (const [nome, ocorr] of Object.entries(seletores)) {
    if (ocorr.length > 1) problemas.push(`classe .${nome} definida ${ocorr.length}x`);
  }

  const js = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).join("\n");
  const funcoes = {};
  for (const m of js.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    (funcoes[m[1]] = funcoes[m[1]] || []).push(m.index);
  }
  for (const [nome, ocorr] of Object.entries(funcoes)) {
    if (ocorr.length > 1) problemas.push(`function ${nome}() declarada ${ocorr.length}x`);
  }

  const ids = {};
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    (ids[m[1]] = ids[m[1]] || []).push(m.index);
  }
  for (const [nome, ocorr] of Object.entries(ids)) {
    if (ocorr.length > 1) problemas.push(`id="${nome}" usado ${ocorr.length}x`);
  }

  if (problemas.length) {
    console.error("\n✗ COLISÃO DE NOME — o build parou:\n");
    problemas.forEach(p => console.error("   · " + p));
    console.error("\nRenomeie o mais novo. O último a ser declarado cala o primeiro,");
    console.error("e isso nunca dá erro: só aparece torto na tela do Michel.\n");
    process.exit(1);
  }
  console.log("✓ sem colisão de nome");
}


/* ══════════════════════════════════════════════════════════════════
   GUARDA DE AUSÊNCIA

   A colisão de nome tem guarda; a DELEÇÃO não tinha. Duas vezes eu
   apaguei código sem querer fatiando o arquivo por índice de string —
   `s[:ini] + novo + s[fim:]` com o `fim` marcado longe demais:

     · as regras .face das cartas do baralho (a carta ficou espelhada)
     · o CSS INTEIRO da Mesa (a tela inicial virou HTML cru numa página
       branca, e o Michel foi quem viu)

   `node --check` não pega: o arquivo continua válido, só que menor.
   Esta lista é o esqueleto do painel. Se um osso some, o build para.
   ══════════════════════════════════════════════════════════════════ */
/* ⚠️ A MESA DA CIGANA SAIU DAQUI EM 01/09/2026, a pedido do Michel ("qro
   matar essa tela inicial"). Os ossos dela (.mesa-tela, montarMesa,
   abrirMesa, ancorarTextoDaBola, preserveAspectRatio) foram removidos desta
   lista NO MESMO COMMIT em que a cena saiu do index.html. Osso de coisa que
   não existe mais não protege nada — só faz o build reclamar de propósito e
   ensina a ignorar o alarme. */
const OSSOS = [
  ".leque{", ".leque-mao{", ".carta-nav{", ".giro{", ".dorso{", ".frente-nav{",
  ".eclipse{", ".tiragem{", ".tira{", ".selo{", ".carimbo{",
  ".proc{", ".faixa-erro{", ".escopo{",
  "function recalcular(", "function renderHoje(", "function renderPagar(",
  "function renderMes(", "function renderOnde(", "function renderComp(",
  "function renderSaude(", "function renderSelo(", "function renderSeloMes(",
  "function montarLeque(", "function avisarSaldoEstimado(",
  "function calcularEclipse(", "function conselhoDoDia(",
  "backface-visibility",
];
function acusarAusencias(html) {
  const faltando = OSSOS.filter(o => !html.includes(o));
  if (faltando.length) {
    console.error("\n✗ SUMIU DO ARQUIVO — o build parou:\n");
    faltando.forEach(f => console.error("   · " + f));
    console.error("\nProvavelmente um replace de bloco levou junto o que não devia.");
    console.error("Confira o diff antes de seguir.\n");
    process.exit(1);
  }
  console.log("✓ esqueleto completo (" + OSSOS.length + " marcos)");
}

let html = fs.readFileSync("index.html", "utf8");
acusarColisoes(html);
acusarAusencias(html);
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
