/* ============================================================================
   PAINEL FINANCEIRO — Worker (Cloudflare)
   ----------------------------------------------------------------------------
   Este arquivo é o painel inteiro: ele guarda o token do Organizze, conversa
   com a API, protege a página com senha e serve o HTML. Não depende do Claude
   pra nada — depois de publicado, o painel vive sozinho.

   Segredos (Settings → Variables and Secrets, tipo "Secret"):
     ORGANIZZE_EMAIL   e-mail da conta do Organizze
     ORGANIZZE_TOKEN   token de https://app.organizze.com.br/configuracoes/api-keys
     SENHA             a senha que VOCÊ vai digitar pra abrir o painel
     SEGREDO           qualquer texto longo e aleatório (assina o cookie)
   Opcional:
     INICIO            data a partir da qual somar o saldo (padrão 2024-01-01)
   ============================================================================ */

const API = "https://api.organizze.com.br/rest/v2";
const UA  = "Painel Riquinho (contato@mikhaelangelo.com.br)";
const COOKIE = "painel_sess";
const VALIDADE = 60 * 60 * 24 * 30; // 30 dias

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/logout") {
      return new Response(null, { status: 302, headers: {
        "location": "/login",
        "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
      }});
    }

    if (p === "/login") {
      if (req.method === "POST") {
        const form = await req.formData();
        if (String(form.get("senha") || "") !== String(env.SENHA || "")) {
          return html(paginaLogin("Senha incorreta."), 401);
        }
        const cookie = await assinar(env);
        return new Response(null, { status: 302, headers: {
          "location": "/",
          "set-cookie": `${COOKIE}=${cookie}; Path=/; Max-Age=${VALIDADE}; HttpOnly; Secure; SameSite=Lax`
        }});
      }
      return html(paginaLogin(""));
    }

    const autenticado = await conferir(req, env);

    if (p === "/api/bootstrap") {
      if (!autenticado) return json({ erro: "sessao" }, 401);
      try {
        const dados = await montarDados(env);
        return json(dados);
      } catch (e) {
        return json({ erro: String(e && e.message || e) }, 502);
      }
    }

    if (!autenticado) return Response.redirect(new URL("/login", url).toString(), 302);
    if (p === "/" || p === "/index.html") return html(PAGINA);
    return new Response("Não encontrado", { status: 404 });
  }
};

/* ------------------------------------------------------------------ auth -- */
async function chave(env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.SEGREDO || "troque-isto")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function assinar(env) {
  const exp = Date.now() + VALIDADE * 1000;
  const msg = "ok." + exp;
  const sig = await crypto.subtle.sign("HMAC", await chave(env), new TextEncoder().encode(msg));
  return msg + "." + b64(sig);
}
async function conferir(req, env) {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/)
    .find(c => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const val = raw.slice(COOKIE.length + 1);
  const parts = val.split(".");
  if (parts.length !== 3) return false;
  const [ok, exp, sig] = parts;
  if (ok !== "ok" || Number(exp) < Date.now()) return false;
  const esperado = await crypto.subtle.sign("HMAC", await chave(env),
    new TextEncoder().encode("ok." + exp));
  return b64(esperado) === sig;
}
function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ---------------------------------------------------------------- helpers - */
function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function html(s, st = 200) {
  return new Response(s, { status: st,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function org(env, caminho) {
  const auth = btoa(`${env.ORGANIZZE_EMAIL}:${env.ORGANIZZE_TOKEN}`);
  const r = await fetch(API + caminho, {
    headers: { "authorization": "Basic " + auth, "user-agent": UA, "accept": "application/json" }
  });
  if (!r.ok) throw new Error(`Organizze ${r.status} em ${caminho}`);
  return r.json();
}

function iso(d) { return d.toISOString().slice(0, 10); }
function addMeses(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function ultimoDia(ano, mes) { return new Date(ano, mes, 0).getDate(); }

/* ============================================================================
   montarDados() — a única ponte entre o Organizze e o painel.
   Sai daqui o objeto DADOS. Nenhuma conta de negócio acontece aqui além de
   agregação bruta: o recalcular() do painel é quem define os números derivados.
   ============================================================================ */
async function montarDados(env) {
  const hoje = new Date();
  const hojeISO = iso(hoje);
  const ano = hoje.getFullYear(), mes = hoje.getMonth() + 1;
  const inicio = env.INICIO || "2024-01-01";

  const [contasRaw, cartoesRaw, categoriasRaw] = await Promise.all([
    org(env, "/accounts"),
    org(env, "/credit_cards"),
    org(env, "/categories")
  ]);

  const cartoes = cartoesRaw.filter(c => !c.archived).map(c => ({
    id: c.id, nome: c.name, fechamento: c.closing_day, vencimento: c.due_day,
    limiteCents: c.limit_cents || null
  }));

  // Faturas de cada cartão (ano corrente). saldo != 0 => em aberto de verdade.
  const faturasPorCartao = await Promise.all(cartoes.map(c => org(env, `/credit_cards/${c.id}/invoices`)));
  const faturas = [];
  faturasPorCartao.forEach((lista, i) => {
    const c = cartoes[i];
    (lista || []).forEach(f => {
      const venc = String(f.date || "").slice(0, 10);
      if (!venc) return;
      const fecha = String(f.closing_date || "").slice(0, 10);
      const abre  = String(f.starting_date || "").slice(0, 10);
      let status;
      if (abre && abre > hojeISO) status = "futura";
      else if (fecha && hojeISO <= fecha) status = "emFormacao";
      else if (venc < hojeISO && f.balance_cents !== 0) status = "vencida";
      else status = "fechada";
      faturas.push({
        cartaoId: c.id, mes: venc.slice(0, 7), vencimento: venc,
        valorCents: f.amount_cents || 0, saldoCents: f.balance_cents || 0, status
      });
    });
  });

  // Transações: do INICIO até 6 meses à frente, em fatias de 3 meses.
  const fim = iso(addMeses(hoje, 6));
  const fatias = [];
  let cursor = new Date(inicio + "T12:00:00");
  while (iso(cursor) < fim) {
    const prox = addMeses(cursor, 3);
    fatias.push([iso(cursor), iso(prox) < fim ? iso(prox) : fim]);
    cursor = prox;
  }
  const blocos = [];
  for (const [a, b] of fatias) {
    blocos.push(await org(env, `/transactions?start_date=${a}&end_date=${b}`));
  }
  const vistos = new Set();
  const lanc = [];
  blocos.flat().forEach(t => { if (!vistos.has(t.id)) { vistos.add(t.id); lanc.push(t); } });

  const catNome = {}; (categoriasRaw || []).forEach(c => { catNome[c.id] = c.name; });
  const catPai  = {}; (categoriasRaw || []).forEach(c => { catPai[c.id] = c.parent_id; });
  function nomeRaiz(id) { const p = catPai[id]; return catNome[p] || catNome[id] || "Sem categoria"; }
  function temTag(t, nome) { return (t.tags || []).some(x => (x.name || x) === nome); }
  const INTERNA = t => temTag(t, "Transferência Interna") || nomeRaiz(t.category_id) === "Transferências";

  // Saldo por conta = soma dos lançamentos PAGOS em conta bancária, desde INICIO.
  // Se a API algum dia passar a devolver saldo pronto, ele ganha prioridade.
  // ⚠️ A API DO ORGANIZZE NÃO DEVOLVE SALDO DE CONTA. Quando ela devolver,
  // o valor dela manda. Enquanto não devolve, o saldo é SOMADO a partir de
  // INICIO — e essa soma só fecha se INICIO for a data em que a conta do
  // Organizze realmente começou. Com INICIO errado o saldo nasce torto e
  // nunca se corrige: em 26/08/2026 o painel anunciou caixa de
  // -R$ 31.372,77 quando o real era +R$ 2.941,23.
  //
  // Por isso o painel agora sabe DE ONDE veio o saldo e avisa quando ele é
  // estimado. Número que o painel não pode conferir não pode ser dito com
  // a mesma cara de um que ele confere.
  let saldoOrigem = "api";
  const contas = contasRaw.filter(a => !a.archived).map(a => {
    const bruto = [a.balance_cents, a.balance_in_cents, a.current_balance_cents]
      .find(v => typeof v === "number");
    let s = (bruto !== undefined) ? bruto : null;
    if (s === null) {
      saldoOrigem = "somado";
      s = 0;
      for (const t of lanc) {
        if (t.account_type === "CreditCard") continue;
        if (t.account_id === a.id && t.paid) s += t.amount_cents;
      }
    }
    return { id: a.id, nome: a.name, manual: a.type === "other", saldoCents: s };
  });

  // Contas a pagar / a receber ainda em aberto (não pagas), em conta bancária.
  // ⚠️ ESTE LIMITE E O HORIZONTE DE projetar() ANDAM JUNTOS. Se aqui for menor,
  // o fim da linha do saldo fica artificialmente otimista: as faturas continuam
  // aparecendo (vêm de outra consulta, 6 meses), mas as contas de Pix/boleto somem.
  // projetar() olha 92 dias — então aqui são 3 meses. Mexeu num, mexe no outro.
  const limite = iso(addMeses(hoje, 3));
  const aPagar = [], aReceber = [];
  for (const t of lanc) {
    if (t.paid || t.account_type === "CreditCard") continue;
    const d = String(t.date).slice(0, 10);
    if (d > limite) continue;
    if (INTERNA(t)) continue;
    const item = { data: d, desc: t.description, cents: t.amount_cents,
                   conta: (contas.find(c => c.id === t.account_id) || {}).nome || "",
                   grupo: grupoDe(t, nomeRaiz(t.category_id)) };
    if (t.amount_cents < 0) aPagar.push(item);
    else aReceber.push({ data: d, desc: t.description, cents: t.amount_cents, expectativa: true });
  }
  aPagar.sort((a, b) => a.data < b.data ? -1 : 1);
  aReceber.sort((a, b) => a.data < b.data ? -1 : 1);

  function grupoDe(t, raiz) {
    if (temTag(t, "Dívida")) return "divida";
    if (temTag(t, "Ass. Essencial") || temTag(t, "Ass. Luxo")) return "assinatura";
    if (temTag(t, "Despesa Fixa")) return "fixa";
    if (temTag(t, "Despesa Varíavel")) return "variavel";
    if (raiz === "Moradia") return "fixa";
    return "outro";
  }

  // Gasto do mês corrente por categoria-raiz (inclui compra de cartão,
  // exclui pagamento de fatura e transferência interna).
  const iniMes = `${ano}-${String(mes).padStart(2, "0")}-01`;
  const fimMes = `${ano}-${String(mes).padStart(2, "0")}-${String(ultimoDia(ano, mes)).padStart(2, "0")}`;
  const gasto = agregarMes(lanc, iniMes, fimMes);

  // Histórico dos 4 meses (o corrente + 3 anteriores)
  const meses = [], serieGasto = [], serieRenda = [], porCat = {};
  for (let k = 3; k >= 0; k--) {
    const d = addMeses(new Date(ano, mes - 1, 1), -k);
    const a = d.getFullYear(), m = d.getMonth() + 1;
    const i0 = `${a}-${String(m).padStart(2, "0")}-01`;
    const i1 = `${a}-${String(m).padStart(2, "0")}-${String(ultimoDia(a, m)).padStart(2, "0")}`;
    const ag = agregarMes(lanc, i0, i1);
    meses.push(i0.slice(0, 7));
    serieGasto.push(ag.totalCents);
    serieRenda.push(ag.rendaCents);
    ag.categorias.forEach(c => { (porCat[c.nome] = porCat[c.nome] || [0, 0, 0, 0])[3 - k] = c.cents; });
  }

  function agregarMes(todos, d0, d1) {
    const mapa = {}, subs = {};
    let total = 0, renda = 0, bruta = 0, interna = 0;
    for (const t of todos) {
      const d = String(t.date).slice(0, 10);
      if (d < d0 || d > d1) continue;
      const raiz = nomeRaiz(t.category_id);
      if (t.amount_cents > 0) {
        bruta += t.amount_cents;
        if (INTERNA(t)) interna += t.amount_cents; else renda += t.amount_cents;
        continue;
      }
      if (INTERNA(t)) continue;
      if (raiz && raiz.toLowerCase().indexOf("fatura") === 0) continue; // pagamento de fatura não é gasto novo
      const v = Math.abs(t.amount_cents);
      mapa[raiz] = (mapa[raiz] || 0) + v;
      const sub = catNome[t.category_id] || "—";
      if (sub !== raiz) { (subs[raiz] = subs[raiz] || {})[sub] = (subs[raiz][sub] || 0) + v; }
      total += v;
    }
    const categorias = Object.keys(mapa).map(n => ({
      nome: n, cents: mapa[n],
      sub: Object.entries(subs[n] || {}).sort((a, b) => b[1] - a[1]).slice(0, 6)
    })).sort((a, b) => b.cents - a.cents);
    return { totalCents: total, categorias, rendaCents: renda, brutaCents: bruta, internaCents: interna };
  }

  // Recorrentes: lidos das TAGS que o Riquinho mantém no Organizze — não de heurística.
  const proximo = [iniMes, iso(addMeses(new Date(ano, mes - 1, 1), 2))];
  const recorrente = { fixas: [], variaveis: [], assinaturas: [] };
  const jaVi = new Set();
  for (const t of lanc) {
    const d = String(t.date).slice(0, 10);
    if (d < proximo[0] || d > proximo[1] || t.amount_cents >= 0) continue;
    const nome = String(t.description || "").trim();
    if (jaVi.has(nome)) continue;
    const v = Math.abs(t.amount_cents);
    if (temTag(t, "Ass. Essencial")) { recorrente.assinaturas.push({ nome, cents: v, classe: "essencial" }); jaVi.add(nome); }
    else if (temTag(t, "Ass. Luxo"))  { recorrente.assinaturas.push({ nome, cents: v, classe: "luxo" });      jaVi.add(nome); }
    else if (temTag(t, "Despesa Fixa")) { recorrente.fixas.push({ nome, cents: v });     jaVi.add(nome); }
    else if (temTag(t, "Despesa Varíavel")) { recorrente.variaveis.push({ nome, cents: v }); jaVi.add(nome); }
  }

  // Dívidas: lançamentos com a tag "Dívida" ainda em aberto, agrupados por descrição-base.
  const dividasMapa = {};
  for (const t of lanc) {
    if (!temTag(t, "Dívida") || t.amount_cents >= 0) continue;
    const base = String(t.description).replace(/\s*\(\d+\/\d+\)\s*$/, "").trim();
    const d = String(t.date).slice(0, 10);
    const alvo = dividasMapa[base] || (dividasMapa[base] = {
      nome: base, parcelaCents: Math.abs(t.amount_cents), restam: 0, saldoCents: 0,
      estado: "correndo", juros: null, negativada: false });
    if (!t.paid && d >= hojeISO) { alvo.restam++; alvo.saldoCents += Math.abs(t.amount_cents); }
  }
  const dividas = Object.values(dividasMapa).filter(d => d.restam > 0);

  // Parcelas de cartão ainda a vencer (compras com total_installments > 1)
  const parcMapa = {};
  for (const t of lanc) {
    if (t.account_type !== "CreditCard" || !(t.total_installments > 1)) continue;
    if (temTag(t, "Dívida")) continue; // já contada como dívida — não contar duas vezes
    const d = String(t.date).slice(0, 10);
    if (d < hojeISO) continue;
    const base = String(t.description).replace(/\s*\d+\/\d+\s*$/, "").trim();
    const alvo = parcMapa[base] || (parcMapa[base] = { desc: base, cents: Math.abs(t.amount_cents), restam: 0 });
    alvo.restam++;
  }
  const parcelas = Object.values(parcMapa).sort((a, b) => b.cents - a.cents);

  const ultimos = lanc
    .filter(t => t.paid && String(t.date).slice(0, 10) <= hojeISO && !INTERNA(t))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 12)
    .map(t => ({ data: String(t.date).slice(0, 10), desc: t.description,
                 cents: t.amount_cents, cat: catNome[t.category_id] || "—" }));

  let orcamentos = [];
  try {
    const b = await org(env, `/budgets/${ano}/${mes}`);
    const total = (b || []).reduce((s, x) => s + (x.amount_in_cents || 0), 0);
    const usado = (b || []).reduce((s, x) => s + Math.abs(x.total || 0), 0);
    if (total > 0) orcamentos = [{ nome: "Gasto livre", tetoCents: total, usadoCents: usado }];
  } catch (e) { /* orçamento é opcional */ }

  return {
    origem: "rede",
    geradoEm: new Date().toISOString(),
    hoje: hojeISO,
    // o painel precisa saber se pode confiar no caixa que está mostrando
    saldoOrigem, inicioSaldo: inicio,
    mesRef: { ano, mes },
    contas, cartoes, faturas, aPagar, aReceber,
    gastoMes: { totalCents: gasto.totalCents, categorias: gasto.categorias },
    historico: {
      meses,
      categorias: Object.keys(porCat).map(n => ({ nome: n, serie: porCat[n] }))
        .sort((a, b) => b.serie[3] - a.serie[3]),
      gastoTotal: serieGasto, rendaLiquida: serieRenda
    },
    rendaMesCents: gasto.rendaCents,
    rendaMesBruta: gasto.brutaCents,
    transferenciaInternaCents: gasto.internaCents,
    recorrente, dividas, parcelas, ultimos, orcamentos
  };
}

/* -------------------------------------------------------------- login UI -- */
function paginaLogin(erro) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Painel</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0A0B;color:#F5F5F6;
 font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
form{width:100%;max-width:320px;padding:28px;background:#131315;border:1px solid #26262A;border-radius:12px}
.m{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.d{width:28px;height:28px;border-radius:8px;background:#3987E5;display:grid;place-items:center;font-weight:700}
h1{font-size:15px;margin:0;font-weight:600}
p{margin:2px 0 0;font-size:12px;color:#6B6B73}
label{display:block;font-size:12px;color:#9C9CA4;margin-bottom:6px}
input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #33333A;background:#0A0A0B;
 color:#F5F5F6;font:inherit;margin-bottom:14px}
input:focus{outline:none;border-color:#3987E5}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3987E5;color:#fff;
 font:inherit;font-weight:600;cursor:pointer}
.e{color:#D03B3B;font-size:12px;margin-bottom:12px}
</style></head><body>
<form method="post" action="/login">
  <div class="m"><div class="d">R</div><div><h1>Painel Financeiro</h1><p>by Riquinho</p></div></div>
  ${erro ? `<div class="e">${erro}</div>` : ""}
  <label for="s">Senha</label>
  <input id="s" name="senha" type="password" autofocus autocomplete="current-password">
  <button type="submit">Entrar</button>
</form></body></html>`;
}

/* ---------------------------------------------------------------- página -- */
const PAGINA = `__HTML_DO_PAINEL__`;
