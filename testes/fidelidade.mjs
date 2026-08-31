/* ============================================================================
   TESTE DE FIDELIDADE — o painel × o Organizze.
   Sobe o worker de verdade (worker-src.js), com a API do Organizze trocada
   por um retrato conferido no MCP, e exige que cada número derivado bata com
   o que o Organizze responde. Número que não tem teste aqui já mentiu uma vez.
   ============================================================================ */
import * as F from "./fixture.mjs";

const env = { ORGANIZZE_EMAIL: "x@y.z", ORGANIZZE_TOKEN: "t", SENHA: "senha", SEGREDO: "seg" };

const real = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const p = u.pathname.replace("/rest/v2", "");
  const ok = o => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (p === "/accounts") return ok(F.accounts);
  if (p === "/credit_cards") return ok(F.credit_cards);
  if (p === "/categories") return ok(F.categories);
  let m = p.match(/^\/credit_cards\/(\d+)\/invoices$/);
  if (m) return ok(F.invoices[m[1]] || []);
  if (p === "/transactions") {
    const a = u.searchParams.get("start_date"), b = u.searchParams.get("end_date");
    return ok(F.transactions.filter(t => t.date >= a && t.date <= b));
  }
  if (p.startsWith("/budgets")) return ok([]);
  return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
};

const mod = (await import("../worker-src.js")).default;

// login → cookie
const r0 = await mod.fetch(new Request("https://p/login", {
  method: "POST", body: new URLSearchParams({ senha: "senha" }) }), env);
const cookie = (r0.headers.get("set-cookie") || "").split(";")[0];

const r = await mod.fetch(new Request("https://p/api/bootstrap", { headers: { cookie } }), env);
const D = await r.json();
globalThis.fetch = real;
if (D.erro) { console.error("bootstrap falhou:", D.erro); process.exit(1); }

let falhas = 0;
const C = c => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
function eq(nome, obtido, esperado) {
  const bom = obtido === esperado;
  if (!bom) falhas++;
  console.log((bom ? "  ✓ " : "  ✗ ") + nome +
    (bom ? "  " + (typeof esperado === "number" ? C(esperado) : esperado)
         : "  esperado " + esperado + ", veio " + obtido));
}
const fat = (cartao, venc) => D.faturas.find(f => f.cartaoId === cartao && f.vencimento === venc) || {};

console.log("\nFATURAS — paga é paga, mesmo sem a API dizer");
eq("MercadoPago ago/26 (o Michel pagou em 06/08)", fat(2261913, "2026-08-08").saldoCents, 0);
eq("MercadoPago ago/26 marcada como paga",         fat(2261913, "2026-08-08").status, "paga");
eq("Inter ago/26 continua vencida",                fat(2261580, "2026-08-12").saldoCents, -777212);
eq("MercadoPago set/26 em formação",               fat(2261913, "2026-09-08").saldoCents, -1189937);
eq("MercadoPago manual set/26",                    fat(2470295, "2026-09-08").saldoCents, -100367);

console.log("\nCARTÃO ABANDONADO — dívida, não conta do mês");
eq("Inter ago/26 congelada",        fat(2261580, "2026-08-12").congelada, true);
eq("Inter set/26 também congelada", fat(2261580, "2026-09-12").congelada, true);
eq("MercadoPago set/26 NÃO congelada", !!fat(2261913, "2026-09-08").congelada, false);
eq("fatura paga não vira congelada",   !!fat(2261913, "2026-08-08").congelada, false);

console.log("\nCONTA-RADAR e ARQUIVADAS não são dinheiro");
eq("nenhuma conta arquivada no caixa", D.contas.filter(c => c.nome === "Conta inicial").length, 0);
eq("conta-radar fora do caixa",        D.contas.filter(c => /previst/i.test(c.nome)).length, 0);
eq("contas visíveis",                  D.contas.length, 4);

console.log("\nGASTO DO MÊS — pagamento de fatura e transferência não são gasto");
/* o gasto do mês é a compra no cartão (R$ 2.614,26 de aluguel) e MAIS NADA:
   o pagamento da fatura de R$ 10.043,72 é a mesma compra chegando pela
   segunda vez, e contá-lo dobrava o mês inteiro. */
eq("gasto do mês = só a compra, sem o pagamento da fatura", D.gastoMes.totalCents, 261426);
eq("transferência interna fora da renda", D.rendaMesCents, 0);
eq("conta arquivada fora do gasto", D.gastoMes.categorias.filter(c => c.nome === "Dívidas e empréstimos").length, 0);

console.log("\nA PAGAR — previsão da conta-radar entra, compra de cartão não");
eq("aluguel de setembro previsto", (D.aPagar.find(p => p.desc === "Aluguel") || {}).cents, -253812);
eq("nenhuma compra de cartão virou conta", D.aPagar.filter(p => p.desc === "Aluguel" && p.data === "2026-08-06").length, 0);

console.log(falhas ? `\n${falhas} falha(s)\n` : "\nTudo bate com o Organizze\n");
process.exit(falhas ? 1 : 0);
