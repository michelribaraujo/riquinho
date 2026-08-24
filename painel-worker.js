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
  const contas = contasRaw.filter(a => !a.archived).map(a => {
    let s = (a.balance_cents !== undefined && a.balance_cents !== null) ? a.balance_cents : null;
    if (s === null) {
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
const PAGINA = `<!DOCTYPE html>
<html lang="pt-BR" data-tema="claro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#F2F6F7">
<title>riquinho</title>
<link rel="icon" type="image/svg+xml" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="%2312142B"/><path d="M16 6.2 L17.5 12.3 L22.9 9.1 L19.7 14.5 L25.8 16 L19.7 17.5 L22.9 22.9 L17.5 19.7 L16 25.8 L14.5 19.7 L9.1 22.9 L12.3 17.5 L6.2 16 L12.3 14.5 L9.1 9.1 L14.5 12.3 Z" fill="none" stroke="%23D9B36A" stroke-width="1.1" stroke-linejoin="round"/><circle cx="16" cy="16" r="1.3" fill="%23D9B36A"/></svg>'>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
/* ============================================================
   1. TOKENS — uma régua só. Degrau só existe se for visível.
   ============================================================ */
:root{
  --t-micro:12px; --t-corpo:14px; --t-sub:20px; --t-num:30px; --t-heroi:56px;
  --e1:4px; --e2:8px; --e3:12px; --e4:20px; --e5:32px; --e6:48px;
  --r-card:16px; --r-chip:9px; --r-pill:999px;
  --fonte: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  --fonte-display: "Cormorant Garamond", Georgia, "Times New Roman", serif;
  /* números vão em Plex Mono: é a fonte de tabela de efeméride, e resolve
     alinhamento de coluna de graça. Fallback sempre monoespaçado. */
  --fonte-num: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --rail:212px;
  --dur:.18s;
}
html[data-tema="claro"]{
  /* riquinho v3 — CARTA CELESTE. Pergaminho, tinta índigo e fio de ouro,
     como os atlas astronômicos antigos: místico pelo TRAÇO, não pela cor berrante.
     ⭐ O ÍNDIGO carrega a interface. O OURO é a luz — marca, estrela, destaque.
     Os sinais são fases da lua: cheia (pode) · minguante (calma) · nova (melhor não).
     ⛔ Continua sem vermelho de alarme: "melhor não" é vinho profundo. */
  --bg:#F7F2E8; --sf:#FDFBF6; --sf2:#F1EBDE; --sf3:#FDFBF6;
  --line:#E6DEC9; --line2:#D2C7AB;
  --ink:#211F2E; --ink2:#5B5768; --ink3:#6C6879;
  --acc:#2C3563; --acc-ink:#F7F2E8; --acc-soft:rgba(44,53,99,.07);
  --indigo:#2C3563; --indigo-vivo:#414E8F; --noite:#191C33;
  --ouro:#C0913A; --ouro-luz:#D9B36A; --ouro-txt:#8A6420;
  --terracota:#B0603F; --terracota-soft:rgba(176,96,63,.10);
  --good:#0A6E52; --warn:#8A6420; --serious:#8A6420; --crit:#7E3B47;
  --good-soft:rgba(10,110,82,.10); --crit-soft:rgba(126,59,71,.10); --warn-soft:rgba(138,100,32,.11);
  --s1:#5668d6; --s2:#c0913a; --s3:#a86fd0; --s4:#3fae8a; --s5:#c96a55; --s6:#2f9fbf;
  --grid:#EEE7D6; --s0:#C7BCA0;
  --sombra:0 1px 2px rgba(33,31,46,.06), 0 1px 1px rgba(33,31,46,.03);
  --sombra-alta:0 10px 30px rgba(33,31,46,.12), 0 2px 6px rgba(33,31,46,.05);
}
html[data-tema="escuro"]{
  /* modo noite — o céu de verdade */
  --bg:#12142B; --sf:#191C33; --sf2:#20243F; --sf3:#282C4A;
  --line:#272B47; --line2:#353A5C;
  --ink:#EFEDF7; --ink2:#A5A2BC; --ink3:#8A87A3;
  --acc:#8D9BE8; --acc-ink:#12142B; --acc-soft:rgba(141,155,232,.14);
  --indigo:#8D9BE8; --indigo-vivo:#414E8F; --noite:#0C0E20;
  --ouro:#D9B36A; --ouro-luz:#E8CC93; --ouro-txt:#D9B36A;
  --terracota:#CE8058; --terracota-soft:rgba(206,128,88,.16);
  --good:#4BC79A; --warn:#D9B36A; --serious:#D9B36A; --crit:#D98A97;
  --good-soft:rgba(75,199,154,.13); --crit-soft:rgba(217,138,151,.13); --warn-soft:rgba(217,179,106,.13);
  --s1:#8d9be8; --s2:#d9b36a; --s3:#bd93e0; --s4:#4bc79a; --s5:#d98a76; --s6:#5fb8d6;
  --grid:#1E2240; --s0:#414566; --sombra:0 1px 2px rgba(0,0,0,.4);
}
/* No claro a caixa branca ganha profundidade em vez de peso de borda:
   sombra baixa desenha o degrau melhor que uma linha escura. */
html[data-tema="claro"] .card,
html[data-tema="claro"] .heroi,
html[data-tema="claro"] .faixa,
html[data-tema="claro"] .cartao{ box-shadow:var(--sombra) }
html[data-tema="claro"] .faixa{ background:var(--line) }
html[data-tema="claro"] .tip{ box-shadow:var(--sombra-alta) }
html[data-tema="claro"] .rail{ background:var(--bg) }
html[data-tema="claro"] .nav button[aria-current="true"]{ background:#FFFFFF; box-shadow:var(--sombra) }
html[data-tema="claro"] .nav button:hover{ background:rgba(255,255,255,.7) }
html[data-tema="claro"] .catlin .trilho,
html[data-tema="claro"] .bul-trilho{ background:#ECEBE6 }
html[data-tema="claro"] .mini-btn{ background:#FFFFFF }
html[data-tema="claro"] .tab[aria-pressed="true"]{ background:#FFFFFF; box-shadow:var(--sombra) }
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  background:var(--bg); color:var(--ink); font-family:var(--fonte);
  font-size:var(--t-corpo); line-height:1.45; -webkit-font-smoothing:antialiased;
  overscroll-behavior-y:none;
}
button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
a{color:inherit}
.num{font-variant-numeric:tabular-nums}
.heroi-num{font-variant-numeric:proportional-nums;letter-spacing:-.028em}

/* ============================================================
   2. ESQUELETO
   ============================================================ */
.app{display:grid;grid-template-columns:var(--rail) 1fr;min-height:100%}

.rail{
  position:sticky;top:0;height:100vh;border-right:1px solid var(--line);
  background:var(--bg);display:flex;flex-direction:column;padding:var(--e4) var(--e3);gap:var(--e5);
}
.marca{display:flex;align-items:center;gap:10px;padding:0 var(--e2)}
.marca-sig{width:30px;height:30px;flex:none;display:block}
.marca-sig #marcaBoca{transition:d .3s ease-out}
.marca-txt{font-family:var(--fonte-display);font-size:19px;font-weight:600;letter-spacing:.01em;line-height:1.05}
.marca-sub{font-size:var(--t-micro);color:var(--ink3);font-weight:400}

.nav{display:flex;flex-direction:column;gap:2px}
.nav button::after{content:attr(data-arc);margin-left:auto;font-family:var(--fonte-display);
  font-size:13px;color:var(--ouro-txt);opacity:.75;font-style:italic}
.nav button{
  display:flex;align-items:center;gap:11px;padding:9px var(--e2);border-radius:var(--r-chip);
  color:var(--ink2);font-size:var(--t-corpo);font-weight:500;text-align:left;width:100%;
  transition:background var(--dur),color var(--dur);
}
.nav button:hover{background:var(--sf);color:var(--ink)}
.nav button[aria-current="true"]{background:var(--sf2);color:var(--ink)}
.nav svg{width:17px;height:17px;flex:none;stroke:currentColor;fill:none;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.nav .badge{font-size:11px;padding:1px 6px;border-radius:var(--r-pill);
  background:var(--crit);color:#fff;font-weight:600}

.rail-pe{margin-top:auto;display:flex;flex-direction:column;gap:var(--e2)}
.rail-pe .linha{display:flex;gap:var(--e1)}
.mini-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px;
  border:1px solid var(--line);border-radius:var(--r-chip);color:var(--ink2);font-size:var(--t-micro)}
.mini-btn:hover{background:var(--sf);color:var(--ink)}

.main{min-width:0;display:flex;flex-direction:column}

.topo{
  position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(14px);border-bottom:1px solid var(--line);
  padding:var(--e3) var(--e5);display:flex;align-items:center;gap:var(--e3);
}
.topo h1{font-family:var(--fonte-display);font-size:26px;font-weight:600;letter-spacing:.005em}
.topo .sep{flex:1}
.selo{
  display:inline-flex;align-items:center;gap:6px;font-size:var(--t-micro);color:var(--ink3);
  padding:4px 9px;border:1px solid var(--line);border-radius:var(--r-pill);white-space:nowrap;
}
.selo b{color:var(--ink2);font-weight:500}
.selo.alerta{border-color:color-mix(in srgb,var(--warn) 45%,var(--line));color:var(--warn)}
.selo .ponto{width:6px;height:6px;border-radius:50%;background:var(--good)}
.selo.alerta .ponto{background:var(--warn)}

.btn-sync{
  display:inline-flex;align-items:center;gap:7px;padding:7px 14px;border-radius:var(--r-chip);
  background:var(--acc);color:var(--acc-ink);font-size:var(--t-corpo);font-weight:600;
  transition:filter var(--dur);white-space:nowrap;
}
.btn-sync:hover{filter:brightness(1.08)}
.btn-sync:disabled{opacity:.55;cursor:default}
.btn-sync svg{width:16px;height:16px}
.girando{animation:gira 1s linear infinite}
@keyframes gira{to{transform:rotate(360deg)}}

.tela{padding:var(--e5);max-width:1180px;width:100%}
.tela[hidden]{display:none}

/* ============================================================
   3. COMPONENTES — cada função tem UMA forma
   ============================================================ */
.bloco{margin-bottom:var(--e6)}
.bloco-h{display:flex;align-items:baseline;gap:var(--e3);margin-bottom:var(--e4)}
.bloco-h h2{font-size:13px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink2)}
.bloco-h h2::before{content:"✦";color:var(--ouro);margin-right:8px;font-size:11px}
.bloco-h .dica{font-size:var(--t-micro);color:var(--ink3)}
.bloco-h .acoes{margin-left:auto;display:flex;gap:var(--e1)}
.tab{padding:4px 10px;border-radius:var(--r-pill);font-size:var(--t-micro);color:var(--ink3);font-weight:500}
.tab[aria-pressed="true"]{background:var(--sf2);color:var(--ink)}
.tab:hover{color:var(--ink)}

.card{background:var(--sf);border:1px solid var(--line);border-radius:var(--r-card);padding:var(--e4)}

/* Herói */
.heroi{
  position:relative;overflow:hidden;
  background:var(--sf);border:1px solid var(--line2);border-radius:var(--r-card);
  padding:var(--e5) var(--e5) var(--e4);display:grid;grid-template-columns:1fr auto;gap:var(--e4);align-items:start;
  /* moldura dupla de carta de tarô: borda + fio interno */
  box-shadow:inset 0 0 0 4px var(--sf), inset 0 0 0 5px var(--line), var(--sombra);
}
.heroi > *{position:relative;z-index:1}
.constel{position:absolute;inset:auto 0 auto auto;top:0;right:0;width:340px;height:100%;
  pointer-events:none;z-index:0;color:var(--ouro);opacity:.5}
html[data-tema="escuro"] .constel{opacity:.8;color:var(--ouro-luz)}
.heroi .rot{font-size:var(--t-micro);color:var(--ink2);font-weight:500;text-transform:uppercase;letter-spacing:.06em}
.heroi .val{font-family:var(--fonte-num);font-size:var(--t-heroi);font-weight:600;line-height:1.02;margin:6px 0 10px;font-variant-numeric:tabular-nums}
.heroi .val.ruim{color:var(--crit)}
.heroi .val.bom{color:var(--ink)}
.heroi .porque{font-size:var(--t-corpo);color:var(--ink2);max-width:44ch}
.heroi .porque b{color:var(--ink);font-weight:600}
.medidor{width:150px;flex:none}

/* Faixa de números irmãos */
.faixa{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r-card);overflow:hidden}
.faixa.c4{grid-template-columns:repeat(4,1fr)}
.faixa.c3{grid-template-columns:repeat(3,1fr)}
.faixa.c2{grid-template-columns:repeat(2,1fr)}
.cel{background:var(--sf);padding:var(--e4) var(--e4)}
.cel .rot{font-size:var(--t-micro);color:var(--ink2);display:flex;align-items:center;gap:5px}
.cel .val{font-family:var(--fonte-num);font-size:var(--t-num);font-weight:600;letter-spacing:-.02em;margin-top:6px;line-height:1.1;white-space:nowrap;font-variant-numeric:tabular-nums}
.cel .pe{font-size:var(--t-micro);color:var(--ink3);margin-top:4px}
.cel .val.ruim{color:var(--crit)} .cel .val.bom{color:var(--good)} .cel .val.atencao{color:var(--warn)}

/* Pílulas de estado */
.pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 8px;
  border-radius:var(--r-pill);letter-spacing:.01em}
.pill.ok{background:var(--good-soft);color:var(--good)}
.pill.ruim{background:var(--crit-soft);color:var(--crit)}
.pill.aten{background:var(--warn-soft);color:var(--warn)}
.pill.neutro{background:var(--sf2);color:var(--ink2)}

.delta{font-size:var(--t-micro);font-weight:600;font-variant-numeric:tabular-nums}
.delta.sobe{color:var(--crit)} .delta.desce{color:var(--good)} .delta.igual{color:var(--ink3)}

/* Insight — régua à esquerda, voz do Riquinho, NUNCA dado */
.insight{border-left:2px solid var(--acc);padding:2px 0 2px var(--e3);margin-bottom:var(--e3)}
.insight p{font-size:var(--t-corpo);color:var(--ink);line-height:1.5}
.insight p b{font-weight:600}
.insight .fonte,.fala .fonte{font-size:var(--t-micro);color:var(--ink3);margin-top:3px}
.insight.aten{border-color:var(--warn)}
.insight.ok{border-color:var(--good)}

/* Lista/tabela compacta */
.lista{width:100%;border-collapse:collapse;font-size:var(--t-corpo)}
.lista th{font-size:var(--t-micro);font-weight:500;color:var(--ink3);text-align:left;
  padding:0 0 var(--e2);border-bottom:1px solid var(--line);white-space:nowrap}
.lista td{padding:11px 0;border-bottom:1px solid var(--line);vertical-align:middle}
.lista tr:last-child td{border-bottom:none}
.lista .r{text-align:right;font-variant-numeric:tabular-nums}
.lista .dim{color:var(--ink3);font-size:var(--t-micro)}
.lista tbody tr:hover td{background:var(--sf2)}

/* Barras horizontais de categoria */
.catlin{display:grid;grid-template-columns:164px 1fr 96px 62px;gap:var(--e3);align-items:center;
  padding:7px 0;cursor:pointer;border-radius:6px}
.catlin:hover{background:var(--sf2)}
.catlin .nome{font-size:var(--t-corpo);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  display:flex;align-items:center;gap:8px}
.catlin .swatch{width:8px;height:8px;border-radius:2px;flex:none}
.catlin .trilho{height:9px;background:var(--sf2);border-radius:3px;overflow:hidden}
.catlin .barra{height:100%;border-radius:3px}
.catlin .v{text-align:right;font-variant-numeric:tabular-nums;font-size:var(--t-corpo);font-weight:500}
.catlin .d{text-align:right}
.catsub{padding:2px 0 12px 172px;display:none}
.catsub.aberto{display:block}
.catsub div{display:flex;justify-content:space-between;font-size:var(--t-micro);color:var(--ink2);
  padding:3px 0;max-width:400px}
.catsub div span:last-child{font-variant-numeric:tabular-nums}

/* Barra empilhada */
.empil{display:flex;gap:2px;height:38px;border-radius:7px;overflow:hidden;margin-bottom:var(--e3)}
.empil > div{position:relative;transition:filter var(--dur)}
.empil > div:hover{filter:brightness(1.15)}
.legenda{display:flex;flex-wrap:wrap;gap:var(--e2) var(--e4)}
.legenda .it{display:flex;align-items:center;gap:7px;font-size:var(--t-micro);color:var(--ink2)}
.legenda .sw{width:9px;height:9px;border-radius:2px;flex:none}
.legenda b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}

/* Bullet (indicador de saúde) */
.bul{padding:var(--e3) 0;border-bottom:1px solid var(--line)}
.bul:last-child{border-bottom:none}
.bul-h{display:flex;align-items:baseline;gap:var(--e2);margin-bottom:9px}
.bul-h .n{font-size:var(--t-corpo);font-weight:500}
.bul-h .v{margin-left:auto;font-size:var(--t-sub);font-weight:600;font-variant-numeric:tabular-nums}
.bul-trilho{position:relative;height:8px;background:var(--sf2);border-radius:3px}
.bul-faixa{position:absolute;top:0;bottom:0;background:var(--good-soft);border-radius:3px}
.bul-marca{position:absolute;top:-3px;width:3px;height:14px;border-radius:2px;background:var(--ink)}
.bul-pe{display:flex;justify-content:space-between;font-size:var(--t-micro);color:var(--ink3);margin-top:6px}

/* Detalhes / abrir a conta */
details.conta{margin-top:var(--e3);border-top:1px solid var(--line);padding-top:var(--e2)}
details.conta summary{font-size:var(--t-micro);color:var(--ink3);cursor:pointer;list-style:none;
  display:inline-flex;align-items:center;gap:5px}
details.conta summary::-webkit-details-marker{display:none}
details.conta summary::before{content:"+";font-weight:600}
details.conta[open] summary::before{content:"−"}
details.conta summary:hover{color:var(--ink)}
.memo{font-size:var(--t-micro);color:var(--ink2);font-variant-numeric:tabular-nums;
  margin-top:var(--e2);line-height:1.8}
.memo span{color:var(--ink3)}

/* Gráficos */
svg.g{display:block;width:100%;overflow:visible}
.g .grid{stroke:var(--grid);stroke-width:1}
.g .eixo{fill:var(--ink3);font-size:11px;font-variant-numeric:tabular-nums}
.g .linha{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.g .area{fill:var(--acc-soft)}
.g .pt{fill:var(--s1);stroke:var(--sf);stroke-width:2}
.spark{width:100%;height:26px;display:block}

.tip{position:fixed;z-index:100;pointer-events:none;background:var(--sf3);border:1px solid var(--line2);
  border-radius:8px;padding:8px 11px;font-size:var(--t-micro);box-shadow:0 8px 24px rgba(0,0,0,.35);
  opacity:0;transition:opacity .12s;max-width:230px}
.tip.on{opacity:1}
.tip .t{font-weight:600;margin-bottom:3px}
.tip .l{display:flex;justify-content:space-between;gap:14px;color:var(--ink2)}
.tip .l b{color:var(--ink);font-variant-numeric:tabular-nums}

.vazio{color:var(--ink3);font-size:var(--t-corpo);padding:var(--e4) 0}
.grade2{display:grid;grid-template-columns:1fr 1fr;gap:var(--e4)}
.grade3{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--e4)}

/* Cartão de crédito */
.cartao{background:var(--sf);border:1px solid var(--line);border-radius:var(--r-card);padding:var(--e4)}
.cartao .top{display:flex;align-items:center;gap:var(--e2);margin-bottom:var(--e3)}
.cartao .top .n{font-weight:600}
.cartao .v{font-size:var(--t-num);font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.cartao .rot{font-size:var(--t-micro);color:var(--ink2)}
.cartao .linhas{margin-top:var(--e3);border-top:1px solid var(--line);padding-top:var(--e2)}
.cartao .linhas div{display:flex;justify-content:space-between;font-size:var(--t-micro);
  color:var(--ink2);padding:3px 0}
.cartao .linhas b{color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums}

/* Agenda */
.dia{display:grid;grid-template-columns:56px 1fr;gap:var(--e3);padding:var(--e3) 0;border-bottom:1px solid var(--line)}
.dia:last-child{border-bottom:none}
.dia .quando{font-size:var(--t-micro);color:var(--ink3);padding-top:2px}
.dia .quando b{display:block;font-size:var(--t-corpo);color:var(--ink);font-weight:600}
.dia .itens > div{display:flex;align-items:center;gap:var(--e2);padding:3px 0;font-size:var(--t-corpo)}
.dia .itens .val{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:500}
.dia.hoje .quando b{color:var(--acc)}

/* A carta da vez — uma carta de tarô de verdade: moldura dupla, arcano, estrela */
.tarocarta{max-width:430px;background:var(--sf);border:1px solid var(--line2);border-radius:14px;
  padding:26px 26px 22px;text-align:center;position:relative;
  box-shadow:inset 0 0 0 5px var(--sf), inset 0 0 0 6px var(--line), var(--sombra)}
/* ── A TIRAGEM DO DIA ──────────────────────────────────────────
   Três cartas na abertura: onde você está · o que se aproxima · o conselho.
   Existe pra matar o scroll atrás do que importa. */
.tiragem{display:grid;grid-template-columns:repeat(auto-fit,minmax(228px,1fr));gap:12px}
.tira{
  background:var(--sf);border:1px solid var(--line);border-radius:10px;
  padding:15px 16px 16px;display:flex;flex-direction:column;gap:3px;
}
.tira .rot{
  font-family:var(--fonte-num);font-size:10px;font-weight:500;
  text-transform:uppercase;letter-spacing:.16em;color:var(--ouro-txt);
}
.tira .val{
  font-family:var(--fonte-num);font-size:clamp(19px,3.2vw,25px);font-weight:600;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.15;margin-top:2px;
}
.tira .txt{font-size:13px;color:var(--ink2);line-height:1.5;margin-top:3px}
.tira .sub{font-family:var(--fonte-num);font-size:11px;color:var(--ink3);letter-spacing:.02em;margin-top:2px}
.tira.conselho{border-color:var(--line2);background:var(--terracota-soft)}
.tira.conselho .val{color:var(--terracota)}

/* ── O ECLIPSE ─────────────────────────────────────────────────
   O dia em que o dinheiro acaba. Vinho, nunca vermelho de alarme:
   a régua da casa continua valendo — susto não ensina a gastar melhor. */
.eclipse{
  display:flex;align-items:center;gap:18px;flex-wrap:wrap;
  padding:16px 18px;border:1px solid var(--line2);border-radius:10px;
  background:var(--crit-soft);
}
.eclipse.azul{background:var(--good-soft)}
.eclipse .disco{flex:0 0 auto}
.eclipse .txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.eclipse .rot{
  font-family:var(--fonte-num);font-size:10.5px;font-weight:500;
  text-transform:uppercase;letter-spacing:.16em;color:var(--ouro-txt);
}
.eclipse .val{
  font-family:var(--fonte-num);font-size:clamp(22px,4.4vw,30px);font-weight:600;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1.1;color:var(--crit);
}
.eclipse.azul .val{color:var(--good)}
.eclipse .quando{font-size:13.5px;color:var(--ink2);line-height:1.5}
.eclipse .quando b{color:var(--ink);font-weight:600}
.eclipse .casa{
  font-family:var(--fonte-num);font-size:11.5px;color:var(--terracota);letter-spacing:.02em;
}
.tarocarta .arcano{font-family:var(--fonte-display);font-style:italic;font-size:14px;color:var(--ouro-txt)}
.tarocarta .estrela{margin:12px auto 10px;display:block;width:44px;height:44px;color:var(--ouro)}
.tarocarta h3{font-family:var(--fonte-display);font-size:24px;font-weight:600;margin-bottom:8px}
.tarocarta p{font-size:var(--t-corpo);color:var(--ink2);line-height:1.55}
.tarocarta .veredito{margin-top:14px;font-variant-numeric:tabular-nums;font-weight:600;font-size:var(--t-sub)}

/* Estado de carga */
.carregando{opacity:.45;transition:opacity var(--dur)}
.erro{border-left:2px solid var(--crit);padding-left:var(--e3);color:var(--ink2);font-size:var(--t-corpo)}



/* Semáforo — três estados, e é a coisa mais importante da tela */
.sinal{display:inline-flex;align-items:center;gap:8px;padding:5px 13px 5px 10px;border-radius:var(--r-pill);
  font-size:var(--t-corpo);font-weight:600;letter-spacing:.01em;margin-bottom:var(--e3)}
.sinal svg{width:14px;height:14px;flex:none}
.sinal.pode{background:var(--good-soft);color:var(--good)}
.sinal.calma{background:var(--warn-soft);color:var(--warn)}
.sinal.nao{background:var(--crit-soft);color:var(--crit)}

/* Voz do riquinho — assinada, primeira pessoa, uma linha */
.fala{border-left:2px solid var(--ouro);padding:2px 0 2px var(--e3);margin-bottom:var(--e3)}
.fala p{font-size:var(--t-corpo);color:var(--ink);line-height:1.5}
.fala .assina{font-family:var(--fonte-display);font-style:italic;font-size:14px;color:var(--ouro-txt);font-weight:600;margin-top:4px;letter-spacing:-.01em}
.fala.calma{border-color:var(--warn)} .fala.nao{border-color:var(--crit)} .fala.pode{border-color:var(--good)}

/* Anomalia */
.anom{display:grid;grid-template-columns:auto 1fr auto;gap:var(--e3);align-items:center;
  padding:11px 0;border-bottom:1px solid var(--line)}
.anom:last-child{border-bottom:none}
.anom .mk{width:8px;height:8px;border-radius:50%;background:var(--warn)}
.anom .tt{font-size:var(--t-corpo)}
.anom .sb{font-size:var(--t-micro);color:var(--ink3);margin-top:2px}
.anom .vv{font-variant-numeric:tabular-nums;font-weight:600;text-align:right}
.casa{font-size:var(--t-micro);color:var(--ouro-txt);font-weight:500}

/* Seletor de período — governa o painel inteiro, então mora no topo e é visível sempre */
.periodo{display:inline-flex;align-items:center;gap:2px;border:1px solid var(--line);
  border-radius:var(--r-chip);background:var(--sf);overflow:hidden}
.periodo button{padding:6px 9px;color:var(--ink2);line-height:1;font-size:15px}
.periodo button:hover:not(:disabled){background:var(--sf2);color:var(--ink)}
.periodo button:disabled{opacity:.3;cursor:default}
.periodo .rot{font-family:var(--fonte-display);padding:6px 12px;font-size:16px;font-weight:600;min-width:138px;text-align:center;
  border-left:1px solid var(--line);border-right:1px solid var(--line);white-space:nowrap}
.periodo .hoje{font-size:var(--t-micro);padding:6px 10px;font-weight:500;color:var(--acc)}

.escopo{font-size:var(--t-micro);color:var(--ink3);margin:-10px 0 var(--e4)}

/* Checklist de contas */
.chk{display:grid;grid-template-columns:26px 1fr auto;gap:var(--e3);align-items:center;
  padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer}
.chk:last-child{border-bottom:none}
.chk:hover{background:var(--sf2)}
.chk .box{width:19px;height:19px;border:1.5px solid var(--line2);border-radius:5px;
  display:grid;place-items:center;color:transparent;font-size:12px;font-weight:700;
  transition:background var(--dur),border-color var(--dur);justify-self:center}
.chk[data-pago="1"] .box{background:var(--good);border-color:var(--good);color:#fff}
.chk[data-pago="1"] .nome{text-decoration:line-through;color:var(--ink3)}
.chk[data-pago="1"] .val{color:var(--ink3)}
.chk .nome{font-size:var(--t-corpo);display:flex;align-items:center;gap:var(--e2);flex-wrap:wrap}
.chk .val{font-size:var(--t-corpo);font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.chk .quando{font-size:var(--t-micro);color:var(--ink3)}
.chk.atrasada .quando{color:var(--crit);font-weight:600}

.progresso{height:8px;background:var(--sf2);border-radius:3px;overflow:hidden;margin:var(--e3) 0 var(--e2)}
/* Anima scaleX, não width: transform roda no compositor e não força recálculo de layout. */
.progresso div{height:100%;width:100%;background:var(--good);border-radius:3px;
  transform-origin:left center;transform:scaleX(0);transition:transform .3s ease-out}
@media (prefers-reduced-motion:reduce){ .progresso div{transition:none} }

/* Responsivo */
@media (max-width:1080px){
  :root{--rail:60px}
  .marca-txt,.marca-sub,.nav span,.mini-btn span{display:none}
  .nav button{justify-content:center;padding:11px 0}
  .rail-pe .linha{flex-direction:column}
  .tela{padding:var(--e4)}
  .grade2,.grade3{grid-template-columns:1fr}
  .faixa.c4{grid-template-columns:1fr 1fr}
}
@media (max-width:640px){
  .app{grid-template-columns:1fr}
  .rail{position:fixed;bottom:0;top:auto;left:0;right:0;height:auto;width:100%;
    flex-direction:row;border-right:none;border-top:1px solid var(--line);padding:6px;
    z-index:50;gap:0}
  .marca,.rail-pe{display:none}
  .nav{flex-direction:row;width:100%;gap:0}
  .nav button{flex-direction:column;gap:3px;font-size:10px;padding:7px 0}
  .nav button::after{display:none}
  .nav span{display:block;font-size:10px}
  .main{padding-bottom:66px}
  .topo{padding:var(--e3) var(--e4);flex-wrap:wrap}
  .topo h1{font-size:var(--t-corpo)}
  .heroi{grid-template-columns:1fr;padding:var(--e4)}
  .heroi .val{font-size:40px}
  .medidor{display:none}
  .faixa.c4,.faixa.c3{grid-template-columns:1fr 1fr}
  .catlin{grid-template-columns:112px 1fr 84px;gap:var(--e2)}
  .catlin .d{display:none}
  .catsub{padding-left:0}
  .cel{padding:var(--e3)}
  .cel .val{font-size:22px}
  .lista td:nth-child(3),.lista th:nth-child(3){display:none}
  .bloco{margin-bottom:var(--e5)}
  .bloco-h{flex-wrap:wrap;gap:var(--e2)}
  .bloco-h .acoes{margin-left:0;width:100%}
  .dia{grid-template-columns:44px 1fr}
  .empil{height:30px}
  .heroi .porque{font-size:var(--t-corpo)}
}
@media print{.rail,.topo .btn-sync{display:none}}
</style>
</head>
<body>

<div class="app">
  <!-- ================= RAIL ================= -->
  <aside class="rail">
    <div class="marca">
      <svg class="marca-sig" id="marcaSig" viewBox="0 0 32 32" aria-hidden="true">
        <!-- Estrela cigana de 8 pontas — o símbolo do povo cigano na umbanda.
             Traço de gravura: ouro sobre a noite, nunca cor chapada infantil. -->
        <circle cx="16" cy="16" r="15" fill="var(--noite)"/>
        <circle cx="16" cy="16" r="12.4" fill="none" stroke="var(--ouro-luz)" stroke-width=".5" opacity=".55"/>
        <path d="M16 6.2 L17.5 12.3 L22.9 9.1 L19.7 14.5 L25.8 16 L19.7 17.5 L22.9 22.9 L17.5 19.7 L16 25.8 L14.5 19.7 L9.1 22.9 L12.3 17.5 L6.2 16 L12.3 14.5 L9.1 9.1 L14.5 12.3 Z"
              fill="none" stroke="var(--ouro-luz)" stroke-width="1.1" stroke-linejoin="round"/>
        <circle cx="16" cy="16" r="1.3" fill="var(--ouro-luz)"/>
        <circle cx="24.6" cy="7.8" r=".7" fill="var(--ouro-luz)" opacity=".85"/>
        <circle cx="7.2" cy="24.2" r=".55" fill="var(--ouro-luz)" opacity=".6"/>
      </svg>
      <div>
        <div class="marca-txt">riquinho</div>
        <div class="marca-sub">seu contador de estrada</div>
      </div>
    </div>

    <nav class="nav" id="nav">
      <button data-tela="hoje" data-arc="I" aria-current="true">
        <svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg><span>Hoje</span>
      </button>
      <button data-tela="pagar" data-arc="II">
        <svg viewBox="0 0 24 24"><path d="M9 11l2 2 4-4"/><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4"/></svg><span>A pagar</span>
      </button>
      <button data-tela="mes" data-arc="III">
        <svg viewBox="0 0 24 24"><path d="M3 17l5-6 4 3 4-7 5 4"/><path d="M3 21h18"/></svg><span>Fluxo</span>
      </button>
      <button data-tela="onde" data-arc="IV">
        <svg viewBox="0 0 24 24"><path d="M4 19V9M10 19V4M16 19v-7M22 19H2"/></svg><span>Onde vai</span>
      </button>
      <button data-tela="comp" data-arc="V">
        <svg viewBox="0 0 24 24"><path d="M3 8h18M3 14h18"/><rect x="3" y="4" width="18" height="16" rx="2"/></svg><span>Comprometido</span>
      </button>
      <button data-tela="saude" data-arc="VI">
        <svg viewBox="0 0 24 24"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg><span>Saúde</span>
      </button>
    </nav>

    <div class="rail-pe">
      <div class="linha">
        <button class="mini-btn" id="btnTema" title="Tema">◐<span>Tema</span></button>
        <button class="mini-btn" id="btnSair" title="Sair">⏻<span>Sair</span></button>
      </div>
    </div>
  </aside>

  <!-- ================= MAIN ================= -->
  <div class="main">
    <header class="topo">
      <h1 id="tituloTela">Hoje</h1>
      <div class="periodo" id="periodo">
        <button id="mesAnt" title="Mês anterior">‹</button>
        <span class="rot" id="mesRot">—</span>
        <button id="mesProx" title="Próximo mês">›</button>
        <button class="hoje" id="mesHoje">hoje</button>
      </div>
      <div class="sep"></div>
      <span class="selo" id="selo"><span class="ponto"></span><b>—</b></span>
      <button class="btn-sync" id="btnSync" title="Renovar a leitura do céu">
        <svg id="iconSync" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-width="1.1" opacity=".45"/>
          <path d="M12 5.6a6.4 6.4 0 100 12.8 8 8 0 110-12.8z" fill="currentColor"/>
        </svg>
        Atualizar
      </button>
    </header>

    <!-- ---------- TELA: HOJE ---------- -->
    <section class="tela" id="tela-hoje">
      <p class="escopo" id="hEscopo"></p>

      <div class="bloco">
        <div class="tiragem" id="hTiragem"></div>
      </div>

      <div class="bloco">
        <div class="heroi">
          <div>
            <div class="sinal" id="hSinal"><span class="luz"></span><span></span></div>
            <div class="rot">Pode gastar hoje</div>
            <div class="val heroi-num" id="hHoje">—</div>
            <div class="porque" id="hPorque"></div>
            <div class="casa" id="hCasa" style="margin-top:10px"></div>
          </div>
          <svg class="medidor g" id="hMedidor" viewBox="0 0 150 96"></svg>
          <svg class="constel" viewBox="0 0 340 260" aria-hidden="true">
            <g fill="currentColor" stroke="currentColor">
              <path d="M228 42 L262 74 L308 58 M262 74 L286 122 L330 138" fill="none" stroke-width=".6" opacity=".5"/>
              <circle cx="228" cy="42" r="1.7"/><circle cx="262" cy="74" r="2.3"/>
              <circle cx="308" cy="58" r="1.4"/><circle cx="286" cy="122" r="1.8"/>
              <circle cx="330" cy="138" r="1.3"/><circle cx="196" cy="96" r="1.1" opacity=".7"/>
              <circle cx="316" cy="196" r="1.5" opacity=".7"/><circle cx="248" cy="170" r="1" opacity=".6"/>
              <path d="M298 214 l2.2 4.6 4.6 2.2 -4.6 2.2 -2.2 4.6 -2.2-4.6 -4.6-2.2 4.6-2.2z" opacity=".8"/>
            </g>
          </svg>
        </div>
      </div>

      <div class="bloco" id="hEclipseBloco" hidden>
        <div class="eclipse" id="hEclipse"></div>
      </div>

      <div class="bloco">
        <div class="faixa c4" id="hFaixa"></div>
        <details class="conta"><summary>abrir a conta</summary><div class="memo" id="hMemo"></div></details>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Ritmo do mês</h2><span class="dica" id="hRitmoDica"></span></div>
        <div class="card" id="hRitmo"></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Anomalias</h2><span class="dica" id="hAnomDica"></span></div>
        <div class="card" id="hAnomalias"></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>A leitura do dia</h2></div>
        <div id="hInsights"></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Últimos lançamentos</h2></div>
        <div class="card"><table class="lista" id="hUltimos"></table></div>
      </div>
    </section>

    <!-- ---------- TELA: A PAGAR ---------- -->
    <section class="tela" id="tela-pagar" hidden>
      <p class="escopo" id="pEscopo"></p>

      <div class="bloco">
        <div class="faixa c4" id="pFaixa"></div>
        <div class="progresso"><div id="pBarra"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:var(--t-micro);color:var(--ink3)">
          <span id="pProgTxt"></span>
          <button class="tab" id="pLimpar">desmarcar tudo</button>
        </div>
      </div>

      <div id="pAviso"></div>

      <div class="bloco">
        <div class="bloco-h"><h2>Contas do mês</h2><span class="dica">toque pra marcar como paga</span></div>
        <div class="card" id="pLista"></div>
        <p class="escopo" style="margin:var(--e2) 0 0">Marcar aqui é o seu controle. Quem confirma de
          verdade é o banco — quando o pagamento chega pelo Open Finance, a conta sai da lista sozinha.</p>
      </div>

      <div class="bloco" id="pEntradasBloco">
        <div class="bloco-h"><h2>Entradas previstas</h2><span class="dica">expectativa, não extrato</span></div>
        <div class="card" id="pEntradas"></div>
      </div>
    </section>

    <!-- ---------- TELA: MÊS ---------- -->
    <section class="tela" id="tela-mes" hidden>
      <p class="escopo" id="mEscopo"></p>
      <div class="bloco">
        <div class="faixa c4" id="mFaixa"></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Saldo projetado</h2><span class="dica">passe o mouse pra ver o dia</span></div>
        <div class="card"><svg class="g" id="mLinha" viewBox="0 0 720 240" style="height:240px"></svg></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Cartões</h2></div>
        <div class="grade3" id="mCartoes"></div>
      </div>
    </section>

    <!-- ---------- TELA: ONDE VAI ---------- -->
    <section class="tela" id="tela-onde" hidden>
      <p class="escopo" id="oEscopo"></p>
      <div class="bloco">
        <div class="faixa c3" id="oFaixa"></div>
      </div>

      <div class="bloco">
        <div class="bloco-h">
          <h2>Por categoria</h2>
          <span class="dica">a coluna da direita é quanto da média mensal já foi usado · o traço na barra é a média</span>
          <div class="acoes">
            <button class="tab" data-jan="mes" aria-pressed="true">Este mês</button>
            <button class="tab" data-jan="media">Média 3 meses</button>
          </div>
        </div>
        <div class="card" id="oCats"></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Como cada uma vem se comportando</h2><span class="dica">4 meses</span></div>
        <div class="card"><div class="grade3" id="oSparks"></div></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Gasto × renda, mês a mês</h2></div>
        <div class="card"><svg class="g" id="oBarras" viewBox="0 0 720 220" style="height:220px"></svg>
          <div class="legenda" style="margin-top:16px">
            <span class="it"><i class="sw" style="background:var(--s2)"></i>Gasto</span>
            <span class="it"><i class="sw" style="background:var(--s3)"></i>Renda (sem transferência interna)</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ---------- TELA: COMPROMETIDO ---------- -->
    <section class="tela" id="tela-comp" hidden>
      <div class="bloco">
        <div class="heroi">
          <div>
            <div class="rot">Já comprometido antes de você acordar</div>
            <div class="val heroi-num" id="cPct">—</div>
            <div class="porque" id="cPorque"></div>
          </div>
        </div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Composição do custo recorrente</h2></div>
        <div class="card">
          <div class="empil" id="cEmpil"></div>
          <div class="legenda" id="cLegenda"></div>
          <details class="conta"><summary>abrir a conta</summary><div class="memo" id="cMemo"></div></details>
        </div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Assinaturas</h2><span class="dica" id="cAssDica"></span></div>
        <div class="card"><table class="lista" id="cAss"></table></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Dívidas ativas</h2><span class="dica">têm parcela correndo e entram no custo do mês</span></div>
        <div class="card"><table class="lista" id="cDiv"></table></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Congeladas</h2><span class="dica">acordo fechado ou renegociação decidida · não saem do caixa de nenhum mês</span></div>
        <div class="card"><table class="lista" id="cCong"></table></div>
      </div>

      <div class="bloco">
        <div class="bloco-h"><h2>Parcelas de cartão ativas</h2><span class="dica" id="cParcDica"></span></div>
        <div class="card"><table class="lista" id="cParc"></table></div>
      </div>
    </section>

    <!-- ---------- TELA: SAÚDE ---------- -->
    <section class="tela" id="tela-saude" hidden>
      <div class="bloco">
        <div class="bloco-h"><h2>Indicadores</h2><span class="dica">a faixa verde é o que o mercado considera saudável</span></div>
        <div class="card" id="sBullets"></div>
      </div>
      <div class="bloco">
        <div class="bloco-h"><h2>A carta da vez</h2><span class="dica">o indicador mais distante da meta escolhe a carta</span></div>
        <div id="sConceito"></div>
      </div>
    </section>
  </div>
</div>

<div class="tip" id="tip"></div>


<script>
/* ============================================================================
   NÚCLEO — arquitetura de três camadas, sem atalho:
       API/DEMO  →  DADOS  →  recalcular()  →  CALC  →  as telas só desenham
   Nenhuma função de render calcula. Todo número derivado nasce em recalcular().
   ============================================================================ */
"use strict";

var DADOS = null;
var CALC  = {};
var ESTADO = { tela:"hoje", mes:null, janela:"mes", carregando:false, origem:"—" };
/* Categorias que alimentam a alma ou a saúde. O painel mostra o número,
   mas NUNCA as aponta como problema num insight. */
var INTOCAVEIS = ["Religião","Saúde","chá","Prevenção e saúde"];

/* ---------- utilitários ---------- */
function C(cents){ // "R$ 1.234,56" — sempre a partir de centavos, nunca de float
  var neg = cents < 0, v = Math.abs(cents)/100;
  return (neg?"−":"") + "R$ " + v.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function Ck(cents){ // versão curta pra eixo de gráfico
  var v = Math.abs(cents)/100, s = cents<0?"−":"";
  if (v >= 1000) return s + (v/1000).toLocaleString("pt-BR",{maximumFractionDigits:1}) + "k";
  return s + v.toLocaleString("pt-BR",{maximumFractionDigits:0});
}
function pct(x){ return (x*100).toLocaleString("pt-BR",{maximumFractionDigits:0}) + "%"; }
function D(iso){ return new Date(iso + "T12:00:00"); }
function iso(d){ return d.toISOString().slice(0,10); }
function diaMes(isoStr){ return Number(isoStr.slice(8,10)); }
function ultimoDia(ano,mes){ return new Date(ano, mes, 0).getDate(); }
function ym(ano,mes){ return ano + "-" + String(mes).padStart(2,"0"); }
function mesCorrente(){ return ym(DADOS.mesRef.ano, DADOS.mesRef.mes); }
function deslocarMes(y, n){
  var a = Number(y.slice(0,4)), m = Number(y.slice(5,7)) + n;
  while (m > 12){ m -= 12; a++; } while (m < 1){ m += 12; a--; }
  return ym(a,m);
}
function rotuloMes(y){ return maiuscula(nomeMesLongo(y)) + " " + y.slice(0,4); }
function proximoMesISO(hojeISO){
  var a = Number(hojeISO.slice(0,4)), m = Number(hojeISO.slice(5,7)) + 1;
  if (m > 12){ m = 1; a++; }
  return a + "-" + String(m).padStart(2,"0");
}
function nomeMesLongo(ym){
  var m = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto",
           "setembro","outubro","novembro","dezembro"];
  return m[Number(ym.slice(5,7))-1];
}
function maiuscula(t){ return t.charAt(0).toUpperCase() + t.slice(1); }
function nomeMesCurto(ym){
  var m = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return m[Number(ym.slice(5,7))-1] + "/" + ym.slice(2,4);
}
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
function soma(arr, f){ var t=0; for (var i=0;i<arr.length;i++) t += f(arr[i]); return t; }

/* ============================================================================
   recalcular() — O ÚNICO LUGAR ONDE NASCE NÚMERO DERIVADO.
   Cada definição tem a regra escrita ao lado. Se a regra não cabe num comentário,
   a regra está errada.
   ============================================================================ */
function recalcular(){
  var c = {};
  c.dadosCarregados = !!(DADOS && DADOS.contas && DADOS.contas.length);
  if (!c.dadosCarregados){ CALC = c; return; }

  var hoje = DADOS.hoje;
  var ano = DADOS.mesRef.ano, mes = DADOS.mesRef.mes;
  var fimMes = ano + "-" + String(mes).padStart(2,"0") + "-" + String(ultimoDia(ano,mes)).padStart(2,"0");

  c.hoje = hoje; c.fimMes = fimMes;
  c.diaDoMes = diaMes(hoje);
  c.diasNoMes = ultimoDia(ano,mes);
  c.diasRestantes = Math.max(1, c.diasNoMes - c.diaDoMes + 1); // inclui hoje

  /* CAIXA = soma do saldo de TODAS as contas. Não entra fatura, não entra
     renda esperada. Proposta não é depósito. */
  c.caixaCents = soma(DADOS.contas, function(a){ return a.saldoCents; });

  /* FATURA EM ABERTO = soma do |saldo| das faturas com saldo ≠ 0 e status ≠ futura.
     Nunca usar "fatura em formação" como se fosse tudo que se deve (armadilha T3):
     ela esconde a fatura que já fechou e não foi paga. */
  // ⛔ Fatura CONGELADA (acordo/renegociação já decidida) não é conta do mês.
  //    Ela existe, aparece em Dívidas, mas não disputa o caixa de setembro.
  var fatAbertas = DADOS.faturas.filter(function(f){
    return f.saldoCents !== 0 && f.status !== "futura" && !f.congelada; });
  c.faturasCongeladas = DADOS.faturas.filter(function(f){ return f.congelada; });
  c.faturasAbertas = fatAbertas;
  c.faturaAbertaCents = soma(fatAbertas, function(f){ return Math.abs(f.saldoCents); });

  /* FATURA QUE VENCE DENTRO DESTE MÊS (ou já venceu e continua aberta) */
  var fatDoMes = fatAbertas.filter(function(f){ return f.vencimento <= fimMes; });
  c.faturaDoMesCents = soma(fatDoMes, function(f){ return Math.abs(f.saldoCents); });

  /* CONTAS A PAGAR ainda deste mês (data ≥ hoje e ≤ fim do mês) */
  var pagarMes = DADOS.aPagar.filter(function(p){ return p.data >= hoje && p.data <= fimMes; });
  c.aPagarMes = pagarMes;
  c.aPagarMesCents = soma(pagarMes, function(p){ return Math.abs(p.cents); });

  /* COMPROMISSOS DO MÊS = contas a pagar + faturas que vencem no mês.
     Renda esperada NÃO entra: o mês corrente se fecha só com o dinheiro que já está na conta. */
  c.compromissosCents = c.aPagarMesCents + c.faturaDoMesCents;

  /* SOBRA DO MÊS = caixa − compromissos. Negativo = o mês não fecha. */
  c.sobraCents = c.caixaCents - c.compromissosCents;
  c.mesFecha = c.sobraCents >= 0;

  /* ORÇAMENTO DE GASTO LIVRE (dopamina). O "chá" e o essencial ficam de fora —
     descontar o essencial do orçamento de prazer seria punir o necessário. */
  var orc = (DADOS.orcamentos && DADOS.orcamentos[0]) || null;
  c.orcTetoCents  = orc ? orc.tetoCents : 0;
  c.orcUsadoCents = orc ? orc.usadoCents : 0;
  c.orcRestaCents = Math.max(0, c.orcTetoCents - c.orcUsadoCents);

  /* TETO DO DIA = o MENOR entre (a) o que sobra do mês dividido pelos dias que faltam
     e (b) o que ainda resta do orçamento de prazer.
     O orçamento de prazer NÃO se divide por dia — é um pote. Quem raciona é a realidade do mês. */
  var porDia = c.sobraCents > 0 ? Math.floor(c.sobraCents / c.diasRestantes) : 0;
  c.tetoPorDiaCents = porDia;
  c.tetoDiaCents = Math.max(0, Math.min(porDia, c.orcRestaCents));
  c.mandaQuem = !c.mesFecha ? "mes" : (porDia <= c.orcRestaCents ? "mes" : "orcamento");

  /* GASTO DO MÊS e RITMO. Ritmo = quanto do mês já passou × quanto do gasto já saiu. */
  c.gastoMesCents = DADOS.gastoMes.totalCents;
  c.gastoPorDiaCents = Math.round(c.gastoMesCents / c.diaDoMes);
  c.projecaoGastoCents = c.gastoPorDiaCents * c.diasNoMes;
  c.rendaMesCents = DADOS.rendaMesCents;

  /* CUSTO RECORRENTE = tudo que sai todo mês sem você decidir nada.
     fixas + variáveis (última leitura) + assinaturas mensalizadas + parcelas de cartão
     + parcelas de dívida correndo. */
  var R = DADOS.recorrente;
  c.fixasCents      = soma(R.fixas, function(x){ return x.cents; });
  c.variaveisCents  = soma(R.variaveis, function(x){ return x.cents; });
  c.assinaturasCents= soma(R.assinaturas, function(x){ return x.anual ? x.cents : x.cents; }); // anuais já vêm mensalizadas
  c.assAnualCents   = soma(R.assinaturas, function(x){ return x.anual ? x.cents*12 : x.cents*12; });
  c.parcelasCents   = soma(DADOS.parcelas, function(x){ return x.cents; });
  var divCorrendo   = DADOS.dividas.filter(function(d){ return d.estado === "correndo"; });
  c.dividasCorrendo = divCorrendo;
  c.dividaParcelaCents = soma(divCorrendo, function(d){ return d.parcelaCents; });
  c.recorrenteCents = c.fixasCents + c.variaveisCents + c.assinaturasCents + c.parcelasCents + c.dividaParcelaCents;

  /* DÍVIDA TOTAL — separada em correndo × congelada (acordo fechado, sem parcela rodando).
     ⛔ saldo total de dívida NUNCA é pagamento do mês. Nunca compare com o caixa. */
  c.dividaCorrendoCents  = soma(divCorrendo, function(d){ return d.saldoCents; });
  c.dividaCongeladaCents = soma(DADOS.dividas.filter(function(d){ return d.estado === "acordo"; }),
                                function(d){ return d.saldoCents; });

  /* RENDA DE REFERÊNCIA = o que se espera receber por mês daqui pra frente.
     É EXPECTATIVA, nunca extrato — só serve pros meses SEGUINTES. */
  c.rendaRefCents = soma(DADOS.aReceber, function(r){ return r.cents; });
  c.pctComprometido = c.rendaRefCents > 0 ? c.recorrenteCents / c.rendaRefCents : 0;

  /* FÔLEGO — simulação mês a mês, não média. Média mente quando um mês tem duas faturas. */
  c.folegoDias = folego(c.caixaCents, c.compromissosCents, c.recorrenteCents, c.diasRestantes);

  /* SALDO PROJETADO DIA A DIA (92 dias — ver comentário em projetar()) */
  c.serieSaldo = projetar();

  /* CATEGORIAS com Δ contra a média dos 3 meses anteriores */
  c.categorias = compararCategorias();

  /* INDICADORES DE SAÚDE */
  c.indicadores = indicadores(c);

  /* CUSTO DA CASA POR DIA — a régua que ele entende melhor que qualquer gráfico:
     traduzir gasto em "dias de casa paga". Moradia + contas de casa ÷ 30. */
  c.casaDiaCents = Math.round((c.fixasCents + c.variaveisCents) / 30);

  /* O ECLIPSE — o dia em que a linha do saldo cruza o zero, e o fundo do poço.
     Este é o número mais importante do painel: é o único que responde "até
     quando eu aguento". Ficava escondido numa célula da tela Mês; agora nasce
     aqui e aparece na tela Hoje. */
  c.eclipse = calcularEclipse(c.serieSaldo, c.casaDiaCents);

  /* SEMÁFORO — pode · calma · melhor não. É a resposta na hora da vontade de comprar. */
  c.semaforo = semaforo(c);

  /* ANOMALIAS — o que fugiu do padrão. Nunca acusa, só mostra. */
  c.anomalias = anomalias(c);

  /* MÊS SELECIONADO — tudo que o seletor do topo governa vive aqui dentro,
     separado do "hoje" pra nunca misturar as duas leituras. */
  c.sel = calcularMes(ESTADO.mes || ym(ano,mes), c);

  /* A TIRAGEM DO DIA — depende de c.sel e c.eclipse, por isso nasce por último. */
  c.conselho = conselhoDoDia(c);

  CALC = c;
  window.__numerosDoPainel = c; // pra conferência externa
}

/* O CONSELHO DO DIA — a terceira carta da tiragem.
   Escolhe UMA coisa só, por ordem de urgência. A regra é dura de propósito:
   se tudo é importante, nada é — e ele para de ler. Nunca cobra, nunca acusa;
   quando não há nada urgente, comemora ou ensina. */
function conselhoDoDia(c){
  var hoje = DADOS.hoje, hojeD = D(hoje);
  function dias(isoStr){ return Math.round((D(isoStr) - hojeD) / 86400000); }

  // 1. A JANELA — a fatura em formação fechando sem caber no caixa.
  //
  //    ⚠️ ESTA CONDIÇÃO JÁ ESTEVE ERRADA. Eu tinha amarrado ela a
  //    \`c.mesFecha === false\`, ou seja, ao mês CORRENTE estourar. Mas a fatura
  //    em formação vence no mês SEGUINTE — então em 24/08/2026, com agosto
  //    fechando redondo e a fatura de 08/09 em R$ 10.260,33 contra um caixa de
  //    R$ 3.187,95, a carta simplesmente não aparecia. Justo na semana em que
  //    ela era a única coisa que importava.
  //
  //    O gatilho certo não é "o mês fechou?" — é "essa fatura cabe no caixa?".
  var maior = null;
  (DADOS.faturas || []).forEach(function(f){
    if (f.status !== "emFormacao" || f.congelada) return;
    if (!maior || Math.abs(f.saldoCents) > Math.abs(maior.saldoCents)) maior = f;
  });
  if (maior){
    var devo = Math.abs(maior.saldoCents);
    var cabe = devo <= c.caixaCents;                 // dá pra pagar à vista?
    var cart = (DADOS.cartoes || []).find(function(x){ return x.id === maior.cartaoId; });
    if (cart && !cabe){
      var f1 = new Date(hojeD); f1.setDate(cart.fechamento);
      if (f1 < hojeD) f1.setMonth(f1.getMonth() + 1);
      var ate = dias(iso(f1));
      if (ate <= 12){
        var venc = cart.vencimento;
        return {
          rot: "A janela",
          val: ate === 0 ? "fecha hoje" : "fecha em " + ate + (ate === 1 ? " dia" : " dias"),
          txt: "A fatura do " + cart.nome + " fecha dia " + cart.fechamento + " com " + C(devo) +
               " — e o caixa hoje é " + C(c.caixaCents) + ". Entre o dia " + cart.fechamento +
               " e o dia " + venc + " é a única janela pra parcelar ela. Depois disso, só pagando."
        };
      }
    }
  }

  // 2. Conta vencendo hoje ou amanhã.
  var proxima = (DADOS.aPagar || []).find(function(p){ return dias(p.data) >= 0 && dias(p.data) <= 1; });
  if (proxima) return {
    rot: "Vence " + (dias(proxima.data) === 0 ? "hoje" : "amanhã"),
    val: C(Math.abs(proxima.cents)),
    txt: proxima.desc + (proxima.conta ? " · " + proxima.conta : "") + ". Entre atrasar Pix e atrasar cartão, o cartão nunca atrasa."
  };

  // 3. O zero chegando em qualquer ponto do horizonte.
  //    ⚠️ ESTA REGRA VEM ANTES DE COMEMORAR O MÊS DE PROPÓSITO. O mês corrente
  //    pode fechar redondo enquanto o seguinte afunda — foi o que aconteceu em
  //    agosto/2026, com agosto fechando e setembro a −R$ 11.937,96. Comemorar
  //    ali seria a mentira confortável que o plano proíbe.
  if (c.eclipse && c.eclipse.negativa){
    var n = c.eclipse.diasAteCruzar;
    return {
      rot: n <= 10 ? "O zero se aproxima" : "O zero, mais à frente",
      val: n <= 0 ? "hoje" : "em " + n + (n === 1 ? " dia" : " dias"),
      txt: "A linha cruza o zero em " + c.eclipse.cruzaEm.slice(8,10) + "/" + c.eclipse.cruzaEm.slice(5,7) +
           (n <= 10 ? ". Dá tempo de escolher o que empurra e o que não empurra."
                    : ". Ainda dá pra mudar esse desenho com calma — e é agora que sai mais barato.")
    };
  }

  // 4. O mês fecha E não tem zero no horizonte. Aí sim é notícia boa de verdade.
  if (c.mesFecha) return {
    rot: "O mês fecha", val: "sozinho",
    txt: "Sem plano, sem remendo, sem parcelar nada — e nenhum zero no horizonte de 3 meses. Era exatamente isso que você disse que queria de todo mês."
  };

  // 5. Nada urgente: a régua do dia.
  return {
    rot: "O teto de hoje", val: C(c.tetoDiaCents),
    txt: c.casaDiaCents > 0
      ? "Sua casa custa " + C(c.casaDiaCents) + " por dia. Hoje não tem nada vencendo — o dia é seu."
      : "Hoje não tem nada vencendo."
  };
}

/* O ECLIPSE — onde a linha do saldo cruza o zero, e onde ela chega no fundo.
   Devolve null quando o horizonte inteiro fica no azul: nesse caso não existe
   eclipse pra anunciar, e anunciar um seria inventar susto. */
function calcularEclipse(serie, casaDia){
  if (!serie || !serie.length) return null;
  var fundo = serie.reduce(function(a,b){ return b.saldo < a.saldo ? b : a; }, serie[0]);
  var cruz = null;
  for (var i=0;i<serie.length;i++){ if (serie[i].saldo < 0) { cruz = serie[i]; break; } }
  var hoje = D(DADOS.hoje);
  function dias(isoStr){ return Math.round((D(isoStr) - hoje) / 86400000); }
  return {
    negativa: !!cruz,
    cruzaEm: cruz ? cruz.data : null,
    diasAteCruzar: cruz ? dias(cruz.data) : null,
    fundoEm: fundo.data,
    fundoCents: fundo.saldo,
    diasAteFundo: dias(fundo.data),
    casa: fundo.saldo < 0 ? emDiasDeCasa(Math.abs(fundo.saldo), casaDia) : ""
  };
}

/* Quantos dias de casa paga cabem num valor. Devolve string curta ou "" quando não vale a pena dizer. */
function emDiasDeCasa(cents, casaDia){
  if (!casaDia || cents < casaDia * 0.5) return "";
  var d = cents / casaDia;
  return d.toLocaleString("pt-BR",{maximumFractionDigits:d < 10 ? 1 : 0}) + (d < 2 ? " dia" : " dias") + " de casa paga";
}

function semaforo(c){
  // MELHOR NÃO — o mês não fecha, ou não sobrou teto nenhum pra hoje.
  if (!c.mesFecha)      return { e:"nao", rot:"Melhor não",
    fala:"O mês está " + C(Math.abs(c.sobraCents)) + " curto. Não é castigo, é aritmética — e a gente resolve juntos." };
  if (c.tetoDiaCents <= 0) return { e:"nao", rot:"Melhor não",
    fala:"O teto de hoje zerou. Amanhã ele nasce de novo." };

  // VAI COM CALMA — o mês fecha, mas tem sinal amarelo em algum lugar.
  var motivos = [];
  if (c.orcTetoCents > 0 && c.orcUsadoCents / c.orcTetoCents > 0.8)
    motivos.push("o orçamento de prazer já foi " + pct(c.orcUsadoCents/c.orcTetoCents) + " usado");
  if (c.folegoDias > 0 && c.folegoDias < 45)
    motivos.push("o caixa segura " + fmtFolego(c.folegoDias) + " sem entrar nada");
  if (c.rajada && c.rajada.n >= 3)
    motivos.push("foram " + c.rajada.n + " compras de prazer em " + c.rajada.quando);
  if (c.rendaMesCents < c.recorrenteCents * 0.5)
    motivos.push("a renda do mês não cobre nem metade do custo fixo");

  if (motivos.length) return { e:"calma", rot:"Vai com calma",
    fala:"Dá pra gastar, mas " + motivos[0] + ". Fica de olho." };

  return { e:"pode", rot:"Pode", fala:"Tá tranquilo. Aproveita sem culpa — o mês está de pé." };
}

/* ANOMALIAS — quatro detectores, todos sobre dado, nenhum sobre suposição.
   ⛔ Categoria intocável nunca vira anomalia. */
function anomalias(c){
  var out = [], hoje = DADOS.hoje, casa = c.casaDiaCents;

  // (1) RAJADA — várias compras de prazer no mesmo dia. É a assinatura do impulso.
  var PRAZER = ["Lazer","Compras","Bares e bebidas","Lugares e rolês","Restaurantes","Lanches","iFood"];
  var porDia = {};
  (DADOS.ultimos || []).forEach(function(l){
    if (l.cents >= 0) return;
    if (PRAZER.indexOf(l.cat) < 0) return;
    (porDia[l.data] = porDia[l.data] || []).push(l);
  });
  var raj = Object.keys(porDia).map(function(d){ return { d:d, itens:porDia[d] }; })
    .filter(function(x){ return x.itens.length >= 3; })
    .sort(function(a,b){ return a.d < b.d ? 1 : -1; })[0];
  if (raj){
    var tot = soma(raj.itens, function(i){ return Math.abs(i.cents); });
    c.rajada = { n:raj.itens.length, quando:"dia " + raj.d.slice(8,10) + "/" + raj.d.slice(5,7), cents:tot };
    out.push({ tipo:"rajada", tt:raj.itens.length + " compras de prazer no mesmo dia",
      sb:"dia " + raj.d.slice(8,10) + "/" + raj.d.slice(5,7) + " · " +
         raj.itens.slice(0,3).map(function(i){ return i.desc; }).join(" · "),
      v:tot, casa:emDiasDeCasa(tot, casa) });
  }

  // (2) VALOR FORA DA CURVA — lançamento muito maior que os outros da mesma categoria.
  var porCat = {};
  (DADOS.ultimos || []).forEach(function(l){
    if (l.cents >= 0) return;
    (porCat[l.cat] = porCat[l.cat] || []).push(Math.abs(l.cents));
  });
  (DADOS.ultimos || []).forEach(function(l){
    if (l.cents >= 0 || INTOCAVEIS.indexOf(l.cat) >= 0) return;
    var lista = porCat[l.cat] || [];
    if (lista.length < 3) return;
    var med = lista.reduce(function(a,b){ return a+b; },0) / lista.length;
    var v = Math.abs(l.cents);
    if (v > med * 2.5 && v > 5000)
      out.push({ tipo:"fora", tt:l.desc, sb:"em " + l.cat + ", o normal é perto de " + C(Math.round(med)),
        v:v, casa:emDiasDeCasa(v, casa) });
  });

  // (3) CATEGORIA QUE JÁ PASSOU DA MÉDIA DO MÊS INTEIRO, com o mês pela metade.
  // Moradia e Dívidas são contratadas e caem de uma vez no começo do mês.
  // Chamar isso de anomalia é ruído — e ruído treina a pessoa a ignorar o alerta.
  var ESTRUTURAIS = ["Moradia","Dívidas"];
  (c.categorias || []).forEach(function(k){
    if (k.intocavel || k.consumo === null || ESTRUTURAIS.indexOf(k.nome) >= 0) return;
    if (k.consumo > 1 && k.frac < 0.75 && k.cents > 20000)
      out.push({ tipo:"estouro", tt:esc(k.nome) + " já passou da média do mês",
        sb:"no dia " + c.diaDoMes + " · a média mensal é " + C(k.media),
        v:k.cents, casa:emDiasDeCasa(k.cents, casa) });
  });

  // (4) ASSINATURA GRANDE demais em relação ao conjunto.
  var ass = (DADOS.recorrente.assinaturas || []).slice().sort(function(a,b){ return b.cents - a.cents; })[0];
  if (ass && c.assinaturasCents > 0 && ass.cents / c.assinaturasCents > 0.30)
    out.push({ tipo:"assinatura", tt:ass.nome + " é " + pct(ass.cents/c.assinaturasCents) + " das suas assinaturas",
      sb:C(ass.cents*12) + " por ano no ritmo de hoje", v:ass.cents, casa:emDiasDeCasa(ass.cents*12, casa) });

  return out.slice(0,5);
}

function calcularMes(y, c){
  var m = { ym:y, rotulo:rotuloMes(y), corrente:(y === mesCorrente()),
            passado:(y < mesCorrente()), futuro:(y > mesCorrente()) };

  // A LISTA DO MÊS = contas que saem da conta + faturas de cartão que vencem nele.
  // Assinatura de cartão não aparece: ela já está dentro da fatura.
  var contas = DADOS.aPagar.filter(function(p){ return p.data.slice(0,7) === y; })
    .map(function(p){ return { data:p.data, desc:p.desc, cents:p.cents, grupo:p.grupo, nota:p.nota }; });
  var fats = DADOS.faturas.filter(function(f){
      return !f.congelada && f.saldoCents !== 0 && f.vencimento.slice(0,7) === y; })
    .map(function(f){
      var cart = DADOS.cartoes.filter(function(x){ return x.id === f.cartaoId; })[0];
      return { data:f.vencimento, desc:"Fatura " + (cart ? cart.nome : "cartão"),
               cents:f.saldoCents, grupo:"fatura" };
    });
  m.itens = contas.concat(fats).sort(function(a,b){
    return a.data === b.data ? Math.abs(b.cents) - Math.abs(a.cents) : (a.data < b.data ? -1 : 1); });
  m.itens.forEach(function(it){ it.chave = it.data + "|" + it.desc + "|" + it.cents; });

  m.totalCents = soma(m.itens, function(i){ return Math.abs(i.cents); });

  var pagos = lerPagos(y);
  m.itens.forEach(function(it){ it.pago = pagos.indexOf(it.chave) >= 0; });
  m.pagosCents = soma(m.itens.filter(function(i){ return i.pago; }), function(i){ return Math.abs(i.cents); });
  m.faltaCents = m.totalCents - m.pagosCents;
  m.qtd = m.itens.length;
  m.qtdPagas = m.itens.filter(function(i){ return i.pago; }).length;

  // Você marcou, o banco não confirmou. É o sintoma do Pix que sai direto da caixinha
  // e não passa pela conta corrente — o Open Finance não enxerga esse caminho.
  m.divergentes = m.itens.filter(function(i){ return i.pago && i.data < DADOS.hoje; });

  m.proxima = m.itens.filter(function(i){ return !i.pago && i.data >= DADOS.hoje; })[0] || null;

  m.receber = DADOS.aReceber.filter(function(r){ return r.data.slice(0,7) === y; });
  m.receberCents = soma(m.receber, function(r){ return r.cents; });

  var g = (DADOS.meses && DADOS.meses[y]) || null;
  m.gastoCents = g ? g.gastoTotal : (m.corrente ? DADOS.gastoMes.totalCents : 0);
  m.rendaCents = g ? g.renda : 0;
  m.temGasto = !!g;

  // Categorias: o mês corrente tem detalhe com subcategoria; os outros vêm da série histórica.
  if (m.corrente) m.categorias = c.categorias;
  else {
    var i = DADOS.historico.meses.indexOf(y);
    m.categorias = i < 0 ? [] : DADOS.historico.categorias
      .map(function(cat){ return { nome:cat.nome, cents:cat.serie[i], sub:[], media:0,
                                   consumo:null, delta:null, frac:1, serie:cat.serie }; })
      .filter(function(k){ return k.cents > 0; });
  }
  return m;
}

var CHAVE_PAGOS = "painel:pagos:";
function lerPagos(y){
  try { return JSON.parse(localStorage.getItem(CHAVE_PAGOS + y) || "[]"); } catch(e){ return []; }
}
function gravarPagos(y, arr){
  try { localStorage.setItem(CHAVE_PAGOS + y, JSON.stringify(arr)); } catch(e){}
}
function alternarPago(y, chave){
  var arr = lerPagos(y), i = arr.indexOf(chave);
  if (i >= 0) arr.splice(i,1); else arr.push(chave);
  gravarPagos(y, arr);
}

function folego(caixa, compromissosMes, recorrente, diasRest){
  if (caixa <= 0) return 0;
  if (caixa < compromissosMes) return -1; // o mês nem fecha
  var restante = caixa - compromissosMes, dias = diasRest;
  var guarda = 0;
  while (restante >= recorrente && recorrente > 0 && guarda < 120){ restante -= recorrente; dias += 30; guarda++; }
  if (recorrente > 0) dias += Math.floor((restante / recorrente) * 30);
  return dias;
}

function projetar(){
  var pts = [], saldo = CALCcaixa(), d = D(DADOS.hoje), hoje = DADOS.hoje;
  var mapa = {};
  // O que já venceu e continua em aberto entra HOJE, não some do gráfico.
  // Empurrar vencido pro passado faria a linha começar mais alta do que a realidade.
  function por(data, cents){ var k = data < hoje ? hoje : data; mapa[k] = (mapa[k]||0) + cents; }
  DADOS.aPagar.forEach(function(p){ por(p.data, p.cents); });
  DADOS.aReceber.forEach(function(r){ por(r.data, r.cents); });
  DADOS.faturas.forEach(function(f){
    if (f.saldoCents !== 0 && f.status !== "futura" && !f.congelada) por(f.vencimento, f.saldoCents);
  });
  /* ⚠️ HORIZONTE — já foi 31 dias, e isso ESCONDIA o fundo do poço.
     Em 20/08/2026 o painel anunciava o menor saldo em 14/09 (−R$ 10.735,23)
     porque a janela acabava em 19/09 — e o DAS + PGFN de 30/09 caíam fora
     dela. O buraco real era −R$ 11.937,96, no último dia do mês.
     O worker já traz lançamento de até 6 meses à frente; quem truncava era
     este laço. 92 dias cobre o mês corrente inteiro mais os dois seguintes.
     Nunca mais encurtar isto sem conferir onde cai o menor saldo.
     ⚠️ AMARRADO ao \`limite\` de aPagar no worker-src.js (3 meses). Se lá for
     menor que aqui, o fim da linha fica otimista e mente de novo.        */
  for (var i=0;i<92;i++){
    var dia = new Date(d.getTime() + i*86400000), k = iso(dia);
    if (mapa[k]) saldo += mapa[k];
    pts.push({ data:k, saldo:saldo, evento: mapa[k]||0 });
  }
  return pts;
}
function CALCcaixa(){ return soma(DADOS.contas, function(a){ return a.saldoCents; }); }

function compararCategorias(){
  var H = DADOS.historico, n = H.meses.length;
  var base = {};
  H.categorias.forEach(function(cat){
    var ant = cat.serie.slice(0, n-1);            // meses anteriores ao corrente
    var med = ant.length ? Math.round(ant.reduce(function(a,b){return a+b;},0)/ant.length) : 0;
    base[cat.nome] = { media: med, serie: cat.serie };
  });
  // Fração do mês já percorrida. Sem isso o dia 17 sempre pareceria "gastando menos"
  // do que a média de meses fechados — comparação injusta que esconde o ritmo real.
  var frac = diaMes(DADOS.hoje) / ultimoDia(DADOS.mesRef.ano, DADOS.mesRef.mes);
  return DADOS.gastoMes.categorias.map(function(cat){
    var b = base[cat.nome] || { media:0, serie:[] };
    var esperado = Math.round(b.media * frac);          // onde a média estaria a esta altura do mês
    var consumo  = b.media > 0 ? cat.cents / b.media : null;   // quanto da média mensal já foi usado
    var delta    = esperado > 0 ? (cat.cents - esperado)/esperado : null;
    return { nome:cat.nome, cents:cat.cents, sub:cat.sub, media:b.media, esperado:esperado,
             consumo:consumo, frac:frac, serie:b.serie, delta:delta,
             intocavel: INTOCAVEIS.indexOf(cat.nome) >= 0 };
  });
}

function indicadores(c){
  var renda = c.rendaRefCents || 1;
  return [
    { nome:"Custo fixo sobre a renda", valor: (c.fixasCents+c.variaveisCents)/renda,
      bomDe:0, bomAte:0.35, max:0.8, fmt:"pct",
      regra:"Moradia, contas e o que não muda. Acima de 35% da renda, qualquer imprevisto vira dívida." },
    { nome:"Parcelas e dívidas sobre a renda", valor: (c.parcelasCents+c.dividaParcelaCents)/renda,
      bomDe:0, bomAte:0.30, max:0.8, fmt:"pct",
      regra:"É o teto que o próprio banco usa pra liberar crédito. Passou de 30%, o mês fica sem folga." },
    { nome:"Total comprometido", valor: c.pctComprometido, bomDe:0, bomAte:0.70, max:1.2, fmt:"pct",
      regra:"Tudo que sai sem você decidir. O que sobra depois disso é a sua liberdade real." },
    { nome:"Reserva de emergência", valor: c.caixaCents/(c.recorrenteCents||1),
      bomDe:3, bomAte:6, max:9, fmt:"meses",
      regra:"Quantos meses você aguenta sem entrar um real. A meta é 3 a 6." },
    { nome:"Assinaturas sobre a renda", valor: c.assinaturasCents/renda,
      bomDe:0, bomAte:0.05, max:0.20, fmt:"pct",
      regra:"Gasto silencioso: renova sozinho e ninguém percebe. Acima de 5% da renda pede revisão." }
  ];
}

/* ============================================================================
   CARREGAMENTO — cache primeiro, rede só quando você pede.
   Ler dado velho em silêncio é a pior mentira que um painel pode contar:
   quando o retrato é guardado, o selo do topo muda de cor e diz há quanto tempo.
   ============================================================================ */
var CHAVE = "painel-riquinho:v1";

function salvarCache(d){
  try { localStorage.setItem(CHAVE, JSON.stringify(d)); } catch(e){}
}
function lerCache(){
  try { var s = localStorage.getItem(CHAVE); return s ? JSON.parse(s) : null; } catch(e){ return null; }
}

async function buscarDaRede(){
  var r = await fetch("/api/bootstrap", { headers:{ "accept":"application/json" }, credentials:"same-origin" });
  if (r.status === 401){ location.href = "/login"; throw new Error("sessao"); }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

async function iniciar(){
  var cache = lerCache();
  if (cache){ DADOS = cache; ESTADO.origem = "cache"; render(); }
  try {
    var d = await buscarDaRede();
    DADOS = d; ESTADO.origem = "rede"; salvarCache(d); render();
  } catch(e){
    if (!DADOS && window.DADOS_DEMO){ DADOS = window.DADOS_DEMO; ESTADO.origem = "demo"; render(); }
    else if (!DADOS){ falhar(e); }
  }
}

async function sincronizar(){
  if (ESTADO.carregando) return;
  ESTADO.carregando = true;
  el("iconSync").classList.add("girando");
  el("btnSync").disabled = true;
  document.querySelectorAll(".tela").forEach(function(t){ t.classList.add("carregando"); });
  try {
    var d = await buscarDaRede();
    DADOS = d; ESTADO.origem = "rede"; salvarCache(d); render();
  } catch(e){
    if (window.DADOS_DEMO && !DADOS){ DADOS = window.DADOS_DEMO; ESTADO.origem = "demo"; render(); }
    else { avisarFalha(e); }
  } finally {
    ESTADO.carregando = false;
    el("iconSync").classList.remove("girando");
    el("btnSync").disabled = false;
    document.querySelectorAll(".tela").forEach(function(t){ t.classList.remove("carregando"); });
  }
}

function falhar(e){
  el("tela-hoje").innerHTML = '<div class="erro">Não consegui ler o Organizze agora.<br>' +
    esc(e.message||"erro") + '</div>';
}
function avisarFalha(){
  var s = el("selo"); s.classList.add("alerta");
  s.innerHTML = '<span class="ponto"></span><b>Rede falhou — mostrando o retrato guardado</b>';
}

/* ============================================================================
   RENDER — daqui pra baixo, ninguém calcula. Só desenha o que está em CALC.
   ============================================================================ */
function render(){
  if (DADOS && ESTADO.mes && mesesDisponiveis().indexOf(ESTADO.mes) < 0) ESTADO.mes = mesCorrente();
  recalcular();
  if (!CALC.dadosCarregados) return;
  renderSelo();
  renderMarca();
  renderPeriodo();
  renderHoje();
  renderPagar();
  renderMes();
  renderOnde();
  renderComp();
  renderSaude();
}

/* O sinal é uma FASE DA LUA — forma carrega o estado junto com a cor:
   cheia (pode) · minguante (calma) · nova (melhor não).
   Quem não distingue cor ainda lê a fase. E o rótulo escrito vem sempre junto. */
function luaFase(estado){
  if (estado === "pode")
    return '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" fill="currentColor"/></svg>';
  if (estado === "calma")
    return '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
           '<path d="M8 1.9a6.1 6.1 0 010 12.2z" fill="currentColor"/></svg>';
  return '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
}
function renderMarca(){}

function renderSelo(){
  var s = el("selo"), q = ESTADO.origem;
  var quando = DADOS.geradoEm ? new Date(DADOS.geradoEm) : null;
  var txt;
  if (q === "demo") txt = "Retrato de demonstração · 17/08/2026";
  else if (q === "cache") txt = "Retrato guardado — toque em Atualizar";
  else txt = "Organizze · " + (quando ? quando.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) : "agora");
  s.className = "selo" + (q === "rede" ? "" : " alerta");
  s.innerHTML = '<span class="ponto"></span><b>' + esc(txt) + "</b>";
}

function renderPeriodo(){
  el("periodo").style.display = USA_PERIODO[ESTADO.tela] ? "inline-flex" : "none";
  var y = ESTADO.mes || mesCorrente();
  el("mesRot").textContent = rotuloMes(y);
  el("mesHoje").hidden = (y === mesCorrente());
  var meses = mesesDisponiveis();
  el("mesAnt").disabled  = meses.indexOf(deslocarMes(y,-1)) < 0;
  el("mesProx").disabled = meses.indexOf(deslocarMes(y, 1)) < 0;
}
function mesesDisponiveis(){
  var set = {};
  Object.keys(DADOS.meses || {}).forEach(function(k){ set[k] = 1; });
  DADOS.aPagar.forEach(function(p){ set[p.data.slice(0,7)] = 1; });
  DADOS.aReceber.forEach(function(r){ set[r.data.slice(0,7)] = 1; });
  set[mesCorrente()] = 1;
  return Object.keys(set).sort();
}

/* --------------------------------------------------------- TELA: A PAGAR -- */
function renderPagar(){
  var m = CALC.sel;

  el("pEscopo").textContent = "Contas que vencem em " + m.rotulo +
    (m.corrente ? " · hoje é dia " + CALC.diaDoMes : "");

  faixa(el("pFaixa"), [
    { rot:"Total do mês", val:C(m.totalCents), pe:m.qtd + (m.qtd === 1 ? " conta" : " contas") },
    { rot:"Você já marcou", val:C(m.pagosCents), pe:m.qtdPagas + " de " + m.qtd, cls: m.qtdPagas ? "bom" : "" },
    { rot:"Falta pagar", val:C(m.faltaCents), pe: m.faltaCents > 0 ? "ainda em aberto" : "tudo marcado",
      cls: m.faltaCents > 0 ? "" : "bom" },
    { rot:"Próxima", val: m.proxima ? C(Math.abs(m.proxima.cents)) : "—",
      pe: m.proxima ? m.proxima.desc + " · " + m.proxima.data.slice(8,10) + "/" + m.proxima.data.slice(5,7) : "nada em aberto" }
  ]);

  var frac = m.totalCents > 0 ? m.pagosCents / m.totalCents : 0;
  el("pBarra").style.transform = "scaleX(" + frac.toFixed(4) + ")";
  el("pProgTxt").textContent = m.qtdPagas + " de " + m.qtd + " marcadas · " + pct(frac);

  el("pAviso").innerHTML = m.divergentes.length
    ? '<div class="insight aten"><p>Você marcou <b>' + m.divergentes.length +
      (m.divergentes.length === 1 ? " conta" : " contas") + '</b> como paga, mas o banco ainda não confirmou: ' +
      m.divergentes.map(function(i){ return esc(i.desc); }).join(", ") +
      '.</p><div class="fonte">costuma ser Pix saindo direto da caixinha — o Open Finance só lê a conta corrente</div></div>'
    : "";

  var porDia = {}, ordem = [];
  m.itens.forEach(function(i){ if (!porDia[i.data]){ porDia[i.data] = []; ordem.push(i.data); } porDia[i.data].push(i); });

  el("pLista").innerHTML = ordem.map(function(d){
    var atrasada = (d < DADOS.hoje);
    return porDia[d].map(function(i, idx){
      return '<div class="chk' + (atrasada && !i.pago ? " atrasada" : "") + '" data-pago="' +
        (i.pago ? "1" : "0") + '" data-chave="' + esc(i.chave) + '" role="checkbox" tabindex="0" aria-checked="' +
        (i.pago ? "true" : "false") + '">' +
        '<div class="box">✓</div>' +
        '<div><div class="nome">' + esc(i.desc) +
          '<span class="pill neutro">' + rotuloGrupo(i.grupo) + "</span>" +
          (i.nota ? '<span class="quando">' + esc(i.nota) + "</span>" : "") + "</div>" +
          '<div class="quando">' + (idx === 0 || true ? "vence " + d.slice(8,10) + "/" + d.slice(5,7) : "") +
          (atrasada && !i.pago ? " · venceu" : "") + "</div></div>" +
        '<div class="val">' + C(Math.abs(i.cents)) + "</div></div>";
    }).join("");
  }).join("") || '<div class="vazio">Nenhuma conta cadastrada pra este mês.</div>';

  el("pLista").querySelectorAll(".chk").forEach(function(n){
    function toca(){ alternarPago(m.ym, n.dataset.chave); render(); }
    n.addEventListener("click", toca);
    n.addEventListener("keydown", function(ev){
      if (ev.key === " " || ev.key === "Enter"){ ev.preventDefault(); toca(); } });
  });

  el("pEntradasBloco").hidden = !m.receber.length;
  el("pEntradas").innerHTML = m.receber.map(function(r){
    return '<div class="chk" style="cursor:default;grid-template-columns:1fr auto">' +
      '<div><div class="nome">' + esc(r.desc) +
      '<span class="pill aten">expectativa</span></div>' +
      '<div class="quando">' + r.data.slice(8,10) + "/" + r.data.slice(5,7) + "</div></div>" +
      '<div class="val" style="color:var(--good)">' + C(r.cents) + "</div></div>";
  }).join("");
}

/* ---------------------------------------------------------- TELA: HOJE ---- */
function renderHoje(){
  var c = CALC;

  var sm = c.semaforo;
  el("hSinal").className = "sinal " + sm.e;
  el("hSinal").innerHTML = luaFase(sm.e) + "<span>" + sm.rot + "</span>";

  el("hHoje").textContent = c.tetoDiaCents > 0 ? C(c.tetoDiaCents) : "Melhor não";
  el("hHoje").className = "val heroi-num " + (c.tetoDiaCents > 0 ? "bom" : "ruim");

  el("hPorque").innerHTML = sm.fala;

  // A régua da casa: dinheiro vira tempo, e tempo ele entende na hora.
  renderTiragem(c);
  renderEclipse(c);

  var dias = emDiasDeCasa(c.tetoDiaCents, c.casaDiaCents);
  el("hCasa").textContent = c.casaDiaCents > 0
    ? "Sua casa custa " + C(c.casaDiaCents) + " por dia" + (dias ? " · o teto de hoje vale " + dias : "")
    : "";

  medidor(el("hMedidor"), c);

  faixa(el("hFaixa"), [
    { rot:"Caixa hoje",           val:C(c.caixaCents),        pe:DADOS.contas.length + " contas" },
    { rot:"Compromissos do mês",  val:C(c.compromissosCents), pe:c.aPagarMes.length + " contas + fatura" },
    { rot:"Sobra",                val:C(c.sobraCents),        pe: c.mesFecha ? "o mês fecha" : "o mês não fecha",
      cls: c.mesFecha ? "bom" : "ruim" },
    { rot:"Fôlego",               val: c.folegoDias < 0 ? "—" : fmtFolego(c.folegoDias),
      pe: c.folegoDias < 0 ? "resolver o mês primeiro" : "sem entrar nada" }
  ]);

  el("hMemo").innerHTML =
    "<span>caixa</span> " + C(c.caixaCents) + "<br>" +
    "<span>− contas a pagar até " + c.fimMes.slice(8,10) + "/" + c.fimMes.slice(5,7) + "</span> " + C(c.aPagarMesCents) + "<br>" +
    "<span>− fatura vencendo no mês</span> " + C(c.faturaDoMesCents) + "<br>" +
    "<span>= sobra</span> <b>" + C(c.sobraCents) + "</b><br>" +
    "<span>÷ " + c.diasRestantes + " dias restantes</span> " + C(c.tetoPorDiaCents) + " por dia";

  ritmo(el("hRitmo"), c);
  el("hRitmoDica").textContent = "dia " + c.diaDoMes + " de " + c.diasNoMes;

  el("hEscopo").textContent = "Retrato de hoje, " + DADOS.hoje.slice(8,10) + "/" +
    DADOS.hoje.slice(5,7) + "/" + DADOS.hoje.slice(0,4) + " · o mês corrente é " + rotuloMes(mesCorrente());
  var an = c.anomalias;
  el("hAnomDica").textContent = an.length
    ? an.length + (an.length === 1 ? " coisa fora do padrão" : " coisas fora do padrão")
    : "nada fora do padrão";
  el("hAnomalias").innerHTML = an.length ? an.map(function(a){
    return '<div class="anom"><span class="mk"></span>' +
      '<div><div class="tt">' + a.tt + "</div>" +
      '<div class="sb">' + a.sb + "</div></div>" +
      '<div><div class="vv">' + C(a.v) + "</div>" +
      (a.casa ? '<div class="sb casa" style="text-align:right">' + a.casa + "</div>" : "") +
      "</div></div>";
  }).join("") : '<div class="vazio">✦ Céu limpo — nada fora do padrão hoje. Isso também é informação.</div>';

  el("hInsights").innerHTML = gerarInsights(c).map(function(i){
    return '<div class="fala ' + (i.tom === "aten" ? "calma" : (i.tom === "ok" ? "pode" : "")) + '">' +
      "<p>" + i.txt + "</p>" +
      (i.fonte ? '<div class="fonte">' + esc(i.fonte) + "</div>" : "") +
      '<div class="assina">— riquinho</div></div>';
  }).join("") || '<div class="vazio">Nada fora da curva hoje.</div>';

  var t = el("hUltimos");
  t.innerHTML = "<tbody>" + DADOS.ultimos.slice(0,8).map(function(l){
    return "<tr><td class='dim' style='width:52px'>" + l.data.slice(8,10) + "/" + l.data.slice(5,7) + "</td>" +
      "<td>" + esc(l.desc) + "</td>" +
      "<td class='dim'>" + esc(l.cat) + "</td>" +
      "<td class='r'>" + C(l.cents) + "</td></tr>";
  }).join("") + "</tbody>";
}

/* A TIRAGEM DO DIA na tela. Sempre três cartas, sempre na mesma ordem —
   é isso que deixa ele achar o número sem procurar. */
function renderTiragem(c){
  var no = el("hTiragem"); if (!no) return;
  var prox = c.sel && c.sel.proxima ? c.sel.proxima : null;
  var q = c.conselho || {};

  function dias(isoStr){
    return Math.round((D(isoStr) - D(DADOS.hoje)) / 86400000);
  }
  function quando(isoStr){
    var n = dias(isoStr);
    if (n <= 0) return "hoje";
    if (n === 1) return "amanhã";
    return "em " + n + " dias";
  }

  no.innerHTML =
    '<div class="tira">' +
      '<span class="rot">Onde você está</span>' +
      '<span class="val">' + C(c.caixaCents) + '</span>' +
      '<span class="txt">Todo o dinheiro que existe agora, em ' + DADOS.contas.length +
        (DADOS.contas.length === 1 ? " conta" : " contas") + '. Sem promessa dentro.</span>' +
    '</div>' +

    '<div class="tira">' +
      '<span class="rot">O que se aproxima</span>' +
      (prox
        ? '<span class="val">' + C(Math.abs(prox.cents)) + '</span>' +
          '<span class="txt">' + esc(prox.desc) + '</span>' +
          '<span class="sub">' + quando(prox.data) + ' · ' + prox.data.slice(8,10) + "/" + prox.data.slice(5,7) + '</span>'
        : '<span class="val">nada</span>' +
          '<span class="txt">Nenhuma conta em aberto no mês. Respira.</span>') +
    '</div>' +

    '<div class="tira conselho">' +
      '<span class="rot">' + esc(q.rot || "O conselho de hoje") + '</span>' +
      '<span class="val">' + esc(q.val || "—") + '</span>' +
      '<span class="txt">' + esc(q.txt || "") + '</span>' +
    '</div>';
}

/* O ECLIPSE na tela. Duas leituras possíveis, nunca uma bronca:
   - a linha cruza o zero  → mostra QUANDO e QUANTO, com a régua da casa
   - a linha nunca cruza   → diz isso, que é notícia boa e merece ser dita */
function renderEclipse(c){
  var e = c.eclipse, bloco = el("hEclipseBloco"), node = el("hEclipse");
  if (!e) { bloco.hidden = true; return; }
  bloco.hidden = false;

  function dataCurta(isoStr){ return isoStr.slice(8,10) + "/" + isoStr.slice(5,7); }
  function emQuantos(n){
    if (n <= 0) return "hoje";
    if (n === 1) return "amanhã";
    return "em " + n + " dias";
  }

  if (!e.negativa){
    node.className = "eclipse azul";
    node.innerHTML =
      '<svg class="disco" width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">' +
        '<circle cx="23" cy="23" r="17" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/>' +
        '<circle cx="23" cy="23" r="17" fill="currentColor" opacity=".22"/></svg>' +
      '<div class="txt">' +
        '<span class="rot">Sem eclipse no horizonte</span>' +
        '<span class="val">' + C(e.fundoCents) + '</span>' +
        '<span class="quando">É o ponto mais baixo dos próximos 3 meses, em <b>' +
          dataCurta(e.fundoEm) + '</b> — e ele não cruza o zero.</span>' +
      '</div>';
    return;
  }

  node.className = "eclipse";
  node.innerHTML =
    '<svg class="disco" width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">' +
      '<circle cx="23" cy="23" r="17" fill="var(--noite, #191C33)"/>' +
      '<circle cx="23" cy="23" r="17" fill="none" stroke="var(--ouro)" stroke-width="1.8"/></svg>' +
    '<div class="txt">' +
      '<span class="rot">Eclipse · ' + dataCurta(e.fundoEm) + '</span>' +
      '<span class="val">' + C(e.fundoCents) + '</span>' +
      '<span class="quando">A linha cruza o zero <b>' + emQuantos(e.diasAteCruzar) +
        '</b>, em ' + dataCurta(e.cruzaEm) + ', e chega no fundo ' + emQuantos(e.diasAteFundo) + '.</span>' +
      (e.casa ? '<span class="casa">o buraco vale ' + e.casa + '</span>' : "") +
    '</div>';
}

function fmtFolego(dias){
  if (dias >= 30){ var m = Math.floor(dias/30), d = dias%30;
    return m + (m>1?" meses":" mês") + (d>0 ? " e " + d + "d" : ""); }
  return dias + " dias";
}

function medidor(svg, c){
  // Arco simples: quanto do mês o caixa cobre. Uma métrica, um arco.
  var cob = c.compromissosCents > 0 ? Math.min(1.4, c.caixaCents / c.compromissosCents) : 1;
  var frac = Math.min(1, cob);
  var cx=75, cy=76, r=58, ini=Math.PI, fim=Math.PI*2;
  function pt(t){ var a = ini + (fim-ini)*t; return [cx + r*Math.cos(a), cy + r*Math.sin(a)]; }
  function arco(t0,t1){ var a=pt(t0), b=pt(t1);
    return "M"+a[0].toFixed(1)+" "+a[1].toFixed(1)+" A"+r+" "+r+" 0 "+((t1-t0)>.5?1:0)+" 1 "+b[0].toFixed(1)+" "+b[1].toFixed(1); }
  var cor = cob >= 1 ? "var(--good)" : (cob >= .7 ? "var(--warn)" : "var(--crit)");
  svg.innerHTML =
    '<path d="'+arco(0,1)+'" fill="none" stroke="var(--line)" stroke-width="1.4"/>' +
    '<path d="'+arco(0,Math.max(.01,frac))+'" fill="none" stroke="'+cor+'" stroke-width="6" stroke-linecap="round"/>' +
    '<text x="75" y="66" text-anchor="middle" fill="var(--ink)" font-size="21" font-weight="600">'+pct(cob)+'</text>' +
    '<text x="75" y="86" text-anchor="middle" fill="var(--ink3)" font-size="11">do mês coberto</text>';
}

function ritmo(node, c){
  var fMes = c.diaDoMes / c.diasNoMes;
  var fGasto = c.projecaoGastoCents > 0 ? Math.min(1, c.gastoMesCents / c.projecaoGastoCents) : 0;
  var linhas = [
    { rot:"Mês percorrido", f:fMes,   cor:"var(--line2)", txt:c.diaDoMes + " de " + c.diasNoMes + " dias" },
    { rot:"Gasto já feito", f:fGasto, cor:"var(--ouro)",
      txt:C(c.gastoMesCents) + " · projeção " + C(c.projecaoGastoCents) }
  ];
  node.innerHTML = linhas.map(function(l){
    return '<div style="margin-bottom:var(--e4)">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px">' +
      '<span style="font-size:var(--t-corpo);color:var(--ink2)">' + l.rot + "</span>" +
      '<span class="num" style="font-size:var(--t-micro);color:var(--ink3)">' + l.txt + "</span></div>" +
      '<div style="height:10px;background:var(--sf2);border-radius:3px;overflow:hidden">' +
      '<div style="height:100%;border-radius:3px;width:' + (l.f*100).toFixed(1) + '%;background:' + l.cor + '"></div>' +
      "</div></div>";
  }).join("").replace(/margin-bottom:var\\(--e4\\)(?![\\s\\S]*margin-bottom:var\\(--e4\\))/, "margin-bottom:0");
}

function gerarInsights(c){
  var out = [];

  // 1. Mês não fecha — aponta a maior peça, seja fatura ou conta
  if (!c.mesFecha){
    var pecas = c.faturasAbertas.map(function(f){
      var cart = DADOS.cartoes.filter(function(x){ return x.id === f.cartaoId; })[0];
      return { nome:"fatura do " + (cart ? cart.nome : "cartão"), v:Math.abs(f.saldoCents), venc:f.vencimento };
    }).concat(c.aPagarMes.map(function(p){ return { nome:p.desc, v:Math.abs(p.cents), venc:p.data }; }));
    var maior = pecas.sort(function(a,b){ return b.v - a.v; })[0];
    if (maior){
      out.push({ tom:"aten", txt:"A maior peça do buraco é <b>" + esc(maior.nome) + "</b>, " +
        C(maior.v) + " em " + maior.venc.slice(8,10) + "/" + maior.venc.slice(5,7) +
        ". Sem ela o mês fecharia com " + C(c.caixaCents - (c.compromissosCents - maior.v)) + ".",
        fonte:"caixa × compromissos, sem contar renda esperada" });
    }
  }

  // 2. Categoria que cresceu sem ele perceber
  var subiu = c.categorias.filter(function(k){
      return !k.intocavel && k.delta !== null && k.delta > 0.4 && k.cents > 20000; })
    .sort(function(a,b){ return b.delta - a.delta; })[0];
  if (subiu){
    out.push({ tom:"aten", txt:"<b>" + esc(subiu.nome) + "</b> está " + pct(subiu.delta) +
      " acima do próprio ritmo: " + C(subiu.cents) + " até o dia " + c.diaDoMes +
      ", quando o normal a esta altura seria " + C(subiu.esperado) + ".",
      fonte:"média dos 3 meses anteriores, ajustada pelos dias já corridos" });
  }

  // 3. Coincidência de datas — o que se acumula num dia só
  var porDia = {};
  c.aPagarMes.concat(DADOS.aPagar.filter(function(p){ return p.data > c.fimMes; })).forEach(function(p){
    porDia[p.data] = (porDia[p.data]||0) + Math.abs(p.cents);
  });
  var pico = Object.keys(porDia).map(function(k){ return { d:k, v:porDia[k] }; })
    .sort(function(a,b){ return b.v - a.v; })[0];
  if (pico && pico.v > c.recorrenteCents*0.25){
    out.push({ tom:"", txt:"Dia <b>" + pico.d.slice(8,10) + "/" + pico.d.slice(5,7) + "</b> concentra " +
      C(pico.v) + " sozinho — o maior tranco de saldo dos próximos 45 dias.",
      fonte:"agenda de contas a pagar" });
  }

  // 4. Mês seguinte sem NENHUMA entrada prevista — só aparece cruzando agenda com calendário
  var proxMes = proximoMesISO(c.hoje);
  var entraNoProx = DADOS.aReceber.filter(function(r){ return r.data.slice(0,7) === proxMes; });
  var saiNoProx = DADOS.aPagar.filter(function(p){ return p.data.slice(0,7) === proxMes; })
    .reduce(function(t,p){ return t + Math.abs(p.cents); }, 0);
  if (!entraNoProx.length && saiNoProx > 0){
    out.push({ tom:"aten", txt:"<b>" + maiuscula(nomeMesLongo(proxMes)) + " não tem nenhuma entrada prevista</b> e já tem " +
      C(saiNoProx) + " marcado pra sair. É o mês que o caixa segura sozinho.",
      fonte:"agenda × calendário" });
  }

  // 5. Assinatura cara demais em relação ao resto
  var ass = DADOS.recorrente.assinaturas.slice().sort(function(a,b){ return b.cents - a.cents; });
  if (ass.length && c.assinaturasCents > 0 && ass[0].cents / c.assinaturasCents > 0.35){
    out.push({ tom:"", txt:"<b>" + esc(ass[0].nome) + "</b> sozinha é " +
      pct(ass[0].cents/c.assinaturasCents) + " de tudo que você paga em assinatura — " +
      C(ass[0].cents*12) + " por ano no ritmo de hoje." + (ass[0].nota ? " (" + esc(ass[0].nota) + ")" : ""),
      fonte:"assinaturas ativas" });
  }

  // 6. Vitória — dívida sem juros não deve ser antecipada, e ele já sabe disso
  var semJuros = c.dividasCorrendo.filter(function(d){ return d.juros === false; });
  if (semJuros.length){
    out.push({ tom:"ok", txt:"Você tem " + C(soma(semJuros,function(d){return d.saldoCents;})) +
      " parcelado <b>sem juros</b>. Esse dinheiro trabalha mais parado no cofrinho a 120% do CDI do que quitando adiantado.",
      fonte:"dívidas com juros = 0" });
  }

  return out.slice(0,5);
}

/* ----------------------------------------------------------- TELA: MÊS ---- */
function renderMes(){
  var c = CALC;
  el("mEscopo").textContent = "Projeção dos próximos 30 dias a partir de hoje · cartões em tempo real";

  faixa(el("mFaixa"), [
    { rot:"Entra no mês",  val:C(c.rendaMesCents),  pe:"já sem transferência interna" },
    { rot:"Sai no mês",    val:C(c.gastoMesCents),  pe:"até hoje" },
    { rot:"Fatura em aberto", val:C(c.faturaAbertaCents), pe:c.faturasAbertas.length + " faturas" },
    /* mesmo número do Eclipse da tela Hoje — uma verdade só, nascida em recalcular() */
    { rot:"Menor saldo previsto", val:C(c.eclipse.fundoCents),
      pe:c.eclipse.fundoEm.slice(8,10)+"/"+c.eclipse.fundoEm.slice(5,7),
      cls: c.eclipse.fundoCents < 0 ? "ruim" : "" }
  ]);

  linhaSaldo(el("mLinha"), c.serieSaldo);

  // A agenda virou a tela "A pagar" — aqui fica só o fluxo e os cartões.

  el("mCartoes").innerHTML = DADOS.cartoes.map(function(cart){
    var fs = DADOS.faturas.filter(function(f){ return f.cartaoId === cart.id; });
    var congelado = fs.some(function(f){ return f.congelada; });
    var aberta = fs.filter(function(f){ return f.saldoCents !== 0 && f.status !== "futura" && !f.congelada; });
    var total = soma(aberta, function(f){ return Math.abs(f.saldoCents); });
    var venc = aberta.length ? aberta.sort(function(a,b){ return a.vencimento < b.vencimento ? -1 : 1; })[0] : null;
    var melhorDia = (cart.fechamento % 31) + 1;
    var prazo = diasDePrazo(cart);
    return '<div class="cartao">' +
      '<div class="top"><span class="n">' + esc(cart.nome) + "</span>" +
      (congelado ? '<span class="pill neutro">congelado</span>' :
        (venc && venc.status === "vencida" ? '<span class="pill ruim">vencida</span>' :
        (total > 0 ? '<span class="pill aten">em aberto</span>' : '<span class="pill ok">zerada</span>'))) + "</div>" +
      '<div class="v">' + C(total) + "</div>" +
      '<div class="rot">' + (venc ? "vence " + venc.vencimento.slice(8,10) + "/" + venc.vencimento.slice(5,7) : "nada em aberto") + "</div>" +
      '<div class="linhas">' +
        "<div>Fecha dia<b>" + cart.fechamento + "</b></div>" +
        "<div>Vence dia<b>" + cart.vencimento + "</b></div>" +
        "<div>Melhor dia pra comprar<b>" + melhorDia + " · " + prazo + " dias</b></div>" +
      "</div></div>";
  }).join("");
}

function rotuloGrupo(g){
  return { fixa:"fixa", variavel:"variável", assinatura:"assinatura", divida:"dívida",
           fatura:"fatura", receita:"entrada" }[g] || g;
}
function diasDePrazo(cart){
  // Comprar logo depois do fechamento dá o prazo máximo: até o vencimento do ciclo seguinte.
  var d = cart.vencimento - cart.fechamento; if (d <= 0) d += 30;
  return d + 30 - 1;
}
function menorSaldo(){
  return CALC.serieSaldo.reduce(function(a,b){ return b.saldo < a.saldo ? b : a; }, CALC.serieSaldo[0]);
}

function linhaSaldo(svg, pts){
  var W=720, H=240, L=52, R=8, T=14, B=26;
  var pw = W-L-R, ph = H-T-B;
  var vals = pts.map(function(p){ return p.saldo; });
  var min = Math.min.apply(null, vals.concat([0])), max = Math.max.apply(null, vals.concat([0]));
  var span = (max-min) || 1; min -= span*0.12; max += span*0.12; span = max-min;
  function x(i){ return L + (i/(pts.length-1))*pw; }
  function y(v){ return T + ph - ((v-min)/span)*ph; }

  var h = "";
  for (var g=0; g<=4; g++){
    var v = min + span*(g/4), yy = y(v);
    h += '<line class="grid" x1="'+L+'" y1="'+yy.toFixed(1)+'" x2="'+(W-R)+'" y2="'+yy.toFixed(1)+'"/>';
    h += '<text class="eixo" x="'+(L-8)+'" y="'+(yy+4).toFixed(1)+'" text-anchor="end">'+Ck(v)+"</text>";
  }
  if (min < 0 && max > 0)
    h += '<line x1="'+L+'" y1="'+y(0).toFixed(1)+'" x2="'+(W-R)+'" y2="'+y(0).toFixed(1)+'" stroke="var(--crit)" stroke-width="1" opacity=".55"/>';

  var d = pts.map(function(p,i){ return (i?"L":"M") + x(i).toFixed(1) + " " + y(p.saldo).toFixed(1); }).join(" ");
  var area = d + " L" + x(pts.length-1).toFixed(1) + " " + y(Math.max(0,min)).toFixed(1) +
             " L" + x(0).toFixed(1) + " " + y(Math.max(0,min)).toFixed(1) + " Z";
  h += '<path class="area" d="'+area+'"/><path class="linha" d="'+d+'"/>';

  var mn = pts.reduce(function(a,b,i){ return b.saldo < a.p.saldo ? {p:b,i:i} : a; }, {p:pts[0],i:0});
  h += '<circle class="pt" cx="'+x(mn.i).toFixed(1)+'" cy="'+y(mn.p.saldo).toFixed(1)+'" r="4.5" style="fill:var(--crit)"/>';
  h += '<text x="'+x(mn.i).toFixed(1)+'" y="'+(y(mn.p.saldo)-12).toFixed(1)+'" text-anchor="middle" fill="var(--crit)" font-size="11" font-weight="600">'+Ck(mn.p.saldo)+"</text>";

  for (var i=0;i<pts.length;i+=5){
    h += '<text class="eixo" x="'+x(i).toFixed(1)+'" y="'+(H-6)+'" text-anchor="middle">'+pts[i].data.slice(8,10)+"/"+pts[i].data.slice(5,7)+"</text>";
  }
  h += '<line id="cross" x1="0" y1="'+T+'" x2="0" y2="'+(T+ph)+'" stroke="var(--line2)" stroke-width="1" opacity="0"/>';
  h += '<rect x="'+L+'" y="'+T+'" width="'+pw+'" height="'+ph+'" fill="transparent" id="hit"/>';
  svg.innerHTML = h;

  var hit = svg.querySelector("#hit"), cross = svg.querySelector("#cross");
  hit.addEventListener("mousemove", function(ev){
    var bb = svg.getBoundingClientRect();
    var rel = (ev.clientX - bb.left)/bb.width*W;
    var i = Math.round(((rel-L)/pw)*(pts.length-1));
    i = Math.max(0, Math.min(pts.length-1, i));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("opacity","1");
    var p = pts[i];
    mostrarTip(ev, p.data.slice(8,10)+"/"+p.data.slice(5,7),
      [["Saldo previsto", C(p.saldo)]].concat(p.evento ? [["Movimento do dia", C(p.evento)]] : []));
  });
  hit.addEventListener("mouseleave", function(){ cross.setAttribute("opacity","0"); esconderTip(); });
}

/* ------------------------------------------------------ TELA: ONDE VAI ---- */
function renderOnde(){
  var c = CALC;
  var msel = c.sel;
  el("oEscopo").textContent = "Gastos de " + msel.rotulo +
    (msel.corrente ? " · mês em andamento, fechado até o dia " + c.diaDoMes : " · mês fechado");
  var diasBase = msel.corrente ? c.diaDoMes : ultimoDia(Number(msel.ym.slice(0,4)), Number(msel.ym.slice(5,7)));
  faixa(el("oFaixa"), [
    { rot:"Gasto", val:C(msel.gastoCents), pe: msel.corrente ? "até dia " + c.diaDoMes : "mês fechado" },
    { rot:"Por dia", val:C(Math.round(msel.gastoCents / diasBase)), pe:"média de " + msel.rotulo },
    { rot: msel.corrente ? "Projeção do mês fechado" : "Renda do mês",
      val: msel.corrente ? C(c.projecaoGastoCents) : C(msel.rendaCents),
      pe: msel.corrente ? "se o ritmo continuar" : "sem transferência interna" }
  ]);

  var cats = msel.categorias.slice().sort(function(a,b){ return b.cents - a.cents; });
  var maxV = Math.max.apply(null, cats.map(function(k){
    return ESTADO.janela === "media" ? Math.max(k.cents,k.media) : k.cents; }));
  var cores = ["var(--s1)","var(--s2)","var(--s3)","var(--s4)","var(--s5)","var(--s6)"];

  el("oCats").innerHTML = cats.map(function(k,i){
    var v = ESTADO.janela === "media" ? k.media : k.cents;
    var cor = i < 6 ? cores[i] : "var(--s0)";
    // "% da média" em vez de delta: quanto da média mensal desta categoria já foi consumido.
    // Verde = está andando abaixo do ritmo do mês; vermelho = já passou da média inteira.
    var cls = "igual", rot = "—";
    if (k.consumo !== null){
      rot = pct(k.consumo);
      cls = k.consumo > 1 ? "sobe" : (k.consumo <= k.frac ? "desce" : "igual");
    }
    var marca = (ESTADO.janela === "mes" && k.media > 0)
      ? '<i style="position:absolute;left:' + Math.min(99,(k.media/maxV*100)).toFixed(1) +
        '%;top:-3px;width:2px;height:15px;background:var(--ink3);border-radius:1px" title="média mensal"></i>' : "";
    return '<div class="catlin" data-i="'+i+'">' +
      '<div class="nome"><i class="swatch" style="background:'+cor+'"></i>' + esc(k.nome) + "</div>" +
      '<div class="trilho" style="position:relative;overflow:visible"><div class="barra" style="width:' +
        Math.max(1,(v/maxV*100)).toFixed(1) + '%;background:'+cor+'"></div>' + marca + "</div>" +
      '<div class="v">' + C(v) + "</div>" +
      '<div class="d"><span class="delta ' + cls + '">' + rot + "</span></div></div>" +
      '<div class="catsub" data-sub="'+i+'">' + (k.sub && k.sub.length ?
        k.sub.map(function(s){ return "<div><span>" + esc(s[0]) + "</span><span>" + C(s[1]) + "</span></div>"; }).join("")
        : "<div><span>sem subcategoria</span><span></span></div>") +
      '<div style="margin-top:6px;color:var(--ink3)"><span>média mensal dos 3 meses anteriores</span><span>' + C(k.media) + "</span></div>" +
      '<div style="color:var(--ink3)"><span>onde a média estaria no dia ' + CALC.diaDoMes + '</span><span>' + C(k.esperado) + "</span></div>" +
      (emDiasDeCasa(k.cents, CALC.casaDiaCents) ? '<div class="casa"><span>vale</span><span>' +
        emDiasDeCasa(k.cents, CALC.casaDiaCents) + "</span></div>" : "") + "</div>";
  }).join("");

  el("oCats").querySelectorAll(".catlin").forEach(function(l){
    l.addEventListener("click", function(){
      var s = el("oCats").querySelector('[data-sub="' + l.dataset.i + '"]');
      s.classList.toggle("aberto");
    });
  });

  // Sparklines por categoria
  var H = DADOS.historico;
  el("oSparks").innerHTML = H.categorias.slice(0,9).map(function(cat){
    var ult = cat.serie[cat.serie.length-1];
    var ant = cat.serie.slice(0,-1);
    var med = ant.length ? ant.reduce(function(a,b){return a+b;},0)/ant.length : 0;
    var dir = med > 0 ? (ult-med)/med : 0;
    return '<div style="padding:4px 0">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">' +
      '<span style="font-size:var(--t-micro);color:var(--ink2)">' + esc(cat.nome) + "</span>" +
      '<span class="delta ' + (dir > .08 ? "sobe" : (dir < -.08 ? "desce" : "igual")) + '">' +
      (dir>0?"+":"") + pct(dir) + "</span></div>" +
      sparkline(cat.serie) +
      '<div style="font-size:11px;color:var(--ink3);margin-top:3px;font-variant-numeric:tabular-nums">' + C(ult) + "</div></div>";
  }).join("");

  barrasMensais(el("oBarras"), H);
}

function sparkline(serie){
  var W=200,H=26, max=Math.max.apply(null,serie)||1;
  var d = serie.map(function(v,i){
    return (i?"L":"M") + (i/(serie.length-1)*W).toFixed(1) + " " + (H - (v/max)*(H-3) - 1).toFixed(1);
  }).join(" ");
  return '<svg class="spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">' +
    '<path d="'+d+'" fill="none" stroke="var(--s1)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
}

function barrasMensais(svg, H){
  var W=720, Hh=220, L=52, R=8, T=12, B=28;
  var pw=W-L-R, ph=Hh-T-B;
  var max = Math.max.apply(null, H.gastoTotal.concat(H.rendaLiquida)) || 1;
  max *= 1.1;
  var n = H.meses.length, slot = pw/n, bw = Math.min(34, slot/3);
  var h = "";
  for (var g=0; g<=3; g++){
    var v = max*(g/3), y = T+ph-(v/max)*ph;
    h += '<line class="grid" x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'"/>';
    h += '<text class="eixo" x="'+(L-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end">'+Ck(v)+"</text>";
  }
  H.meses.forEach(function(m,i){
    var cx = L + slot*i + slot/2;
    var hg = (H.gastoTotal[i]/max)*ph, hr = (H.rendaLiquida[i]/max)*ph;
    h += '<rect x="'+(cx-bw-1).toFixed(1)+'" y="'+(T+ph-hg).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(1,hg).toFixed(1)+'" rx="3" fill="var(--s2)"/>';
    h += '<rect x="'+(cx+1).toFixed(1)+'" y="'+(T+ph-hr).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(1,hr).toFixed(1)+'" rx="3" fill="var(--s3)"/>';
    h += '<text class="eixo" x="'+cx.toFixed(1)+'" y="'+(Hh-8)+'" text-anchor="middle">'+nomeMesCurto(m)+"</text>";
  });
  svg.innerHTML = h;
}

/* -------------------------------------------------- TELA: COMPROMETIDO ---- */
function renderComp(){
  var c = CALC;
  el("cPct").textContent = pct(c.pctComprometido);
  el("cPct").className = "val heroi-num " + (c.pctComprometido > .75 ? "ruim" : "bom");
  var livre = c.rendaRefCents - c.recorrenteCents;
  el("cPorque").innerHTML = C(c.recorrenteCents) + " saem todo mês sem você tocar em nada, contra uma renda de referência de <b>" +
    C(c.rendaRefCents) + "</b>. " + (livre >= 0
      ? "Sobram <b>" + C(livre) + "</b> pra tudo o que é escolha sua."
      : "<b>Faltam " + C(Math.abs(livre)) + "</b> antes mesmo de você escolher qualquer coisa — é aqui que o mês começa a estourar.");

  var partes = [
    { n:"Fixas",       v:c.fixasCents,       cor:"var(--s1)" },
    { n:"Variáveis",   v:c.variaveisCents,   cor:"var(--s4)" },
    { n:"Assinaturas", v:c.assinaturasCents, cor:"var(--s5)" },
    { n:"Parcelas",    v:c.parcelasCents,    cor:"var(--s2)" },
    { n:"Dívidas",     v:c.dividaParcelaCents, cor:"var(--s6)" },
    { n:"Livre",       v:Math.max(0, c.rendaRefCents - c.recorrenteCents), cor:"var(--sf3)" }
  ];
  partes = partes.filter(function(p){ return p.v > 0; });
  el("cEmpil").innerHTML = partes.map(function(p){
    return '<div style="flex:' + Math.max(0.01,p.v) + ';background:' + p.cor + '" title="' + esc(p.n) + '"></div>';
  }).join("");
  el("cLegenda").innerHTML = partes.map(function(p){
    return '<span class="it"><i class="sw" style="background:'+p.cor+'"></i>' + p.n + " <b>" + C(p.v) + "</b></span>";
  }).join("");
  el("cMemo").innerHTML =
    "<span>fixas</span> " + C(c.fixasCents) + "<br>" +
    "<span>+ variáveis (última leitura)</span> " + C(c.variaveisCents) + "<br>" +
    "<span>+ assinaturas (anuais já mensalizadas)</span> " + C(c.assinaturasCents) + "<br>" +
    "<span>+ parcelas de cartão</span> " + C(c.parcelasCents) + "<br>" +
    "<span>+ parcelas de dívida correndo</span> " + C(c.dividaParcelaCents) + "<br>" +
    "<span>= custo recorrente</span> <b>" + C(c.recorrenteCents) + "</b>";

  var ass = DADOS.recorrente.assinaturas.slice().sort(function(a,b){ return b.cents - a.cents; });
  el("cAss").innerHTML = "<thead><tr><th>Assinatura</th><th>Classe</th><th class='r'>Por mês</th><th class='r'>Por ano</th></tr></thead><tbody>" +
    ass.map(function(a){
      return "<tr><td>" + esc(a.nome) + (a.nota ? ' <span class="dim">' + esc(a.nota) + "</span>" : "") + "</td>" +
        '<td><span class="pill ' + (a.classe === "luxo" ? "neutro" : "ok") + '">' + a.classe + "</span></td>" +
        "<td class='r'>" + C(a.cents) + "</td><td class='r dim'>" + C(a.cents*12) + "</td></tr>";
    }).join("") + "</tbody>";
  el("cAssDica").textContent = ass.length + " ativas · " + C(c.assinaturasCents) + "/mês · " + C(c.assinaturasCents*12) + "/ano";

  el("cDiv").innerHTML = "<thead><tr><th>Dívida</th><th>Estado</th><th class='r'>Parcela</th><th class='r'>Restam</th><th class='r'>Saldo</th></tr></thead><tbody>" +
    DADOS.dividas.filter(function(d){ return d.estado === "correndo"; })
      .sort(function(a,b){ return b.saldoCents - a.saldoCents; }).map(function(d){
      var est = d.juros ? '<span class="pill aten">com juros</span>' : '<span class="pill ok">sem juros</span>';
      return "<tr><td>" + esc(d.nome) + (d.negativada ? ' <span class="dim">negativada</span>' : "") + "</td>" +
        "<td>" + est + "</td>" +
        "<td class='r'>" + (d.parcelaCents ? C(d.parcelaCents) : "<span class='dim'>—</span>") + "</td>" +
        "<td class='r'>" + (d.restam ? d.restam + "x" : "<span class='dim'>—</span>") + "</td>" +
        "<td class='r'>" + C(d.saldoCents) + "</td></tr>";
    }).join("") + "</tbody>";

  var cong = DADOS.dividas.filter(function(d){ return d.estado === "acordo"; })
    .sort(function(a,b){ return b.saldoCents - a.saldoCents; });
  el("cCong").innerHTML = "<thead><tr><th>Dívida</th><th></th><th class='r'>Saldo</th></tr></thead><tbody>" +
    cong.map(function(d){
      return "<tr><td>" + esc(d.nome) + (d.nota ? ' <span class="dim">' + esc(d.nota) + "</span>" : "") + "</td>" +
        "<td>" + (d.negativada ? '<span class="pill neutro">negativada</span>' : "") + "</td>" +
        "<td class='r'>" + C(d.saldoCents) + "</td></tr>";
    }).join("") + "</tbody>";

  var parc = DADOS.parcelas.slice().sort(function(a,b){ return b.cents - a.cents; });
  el("cParc").innerHTML = "<thead><tr><th>Compra</th><th class='r'>Parcela</th><th class='r'>Faltam</th><th class='r'>Total a vencer</th></tr></thead><tbody>" +
    parc.map(function(p){
      return "<tr><td>" + esc(p.desc) + "</td><td class='r'>" + C(p.cents) + "</td>" +
        "<td class='r'>" + p.restam + "x</td><td class='r dim'>" + C(p.cents*p.restam) + "</td></tr>";
    }).join("") + "</tbody>";
  el("cParcDica").textContent = C(c.parcelasCents) + "/mês · " +
    C(soma(parc, function(p){ return p.cents*p.restam; })) + " ainda a vencer";
}

/* --------------------------------------------------------- TELA: SAÚDE ---- */
function renderSaude(){
  el("sBullets").innerHTML = CALC.indicadores.map(function(k){
    var max = k.max, v = Math.min(k.valor, max);
    var f0 = (k.bomDe/max)*100, f1 = (k.bomAte/max)*100, p = (v/max)*100;
    var dentro = k.valor >= k.bomDe && k.valor <= k.bomAte;
    var txt = k.fmt === "pct" ? pct(k.valor) : k.valor.toLocaleString("pt-BR",{maximumFractionDigits:1}) + " meses";
    return '<div class="bul"><div class="bul-h"><span class="n">' + esc(k.nome) + "</span>" +
      '<span class="pill ' + (dentro ? "ok" : "aten") + '">' + (dentro ? "saudável" : "fora da faixa") + "</span>" +
      '<span class="v" style="color:' + (dentro ? "var(--good)" : "var(--warn)") + '">' + txt + "</span></div>" +
      '<div class="bul-trilho"><div class="bul-faixa" style="left:'+f0.toFixed(1)+'%;width:'+(f1-f0).toFixed(1)+'%"></div>' +
      '<div class="bul-marca" style="left:calc('+p.toFixed(1)+'% - 1.5px)"></div></div>' +
      '<div class="bul-pe"><span>' + esc(k.regra) + "</span><span>meta " +
      (k.fmt === "pct" ? pct(k.bomAte) : k.bomDe + "–" + k.bomAte + " meses") + "</span></div></div>";
  }).join("");

  // A carta da vez: o indicador mais distante da meta vira uma carta de tarô.
  // "Distante" vale pros DOIS lados: reserva de 0,4 mês contra meta de 3 está
  // 7x abaixo — muito pior que assinatura 1,2x acima. Uma carta só por dia.
  function distancia(k){
    if (k.valor > k.bomAte) return k.valor / k.bomAte;          // estourou por cima
    if (k.bomDe > 0 && k.valor < k.bomDe)
      return k.bomDe / Math.max(k.valor, 0.01);                 // ficou por baixo
    return 0;                                                    // dentro da faixa
  }
  var pior = CALC.indicadores.slice().sort(function(a,b){
    return distancia(b) - distancia(a); })[0];
  if (pior && distancia(pior) === 0) pior = null;
  var estrelaSvg = '<svg class="estrela" viewBox="0 0 32 32" fill="none">' +
    '<path d="M16 6.2 L17.5 12.3 L22.9 9.1 L19.7 14.5 L25.8 16 L19.7 17.5 L22.9 22.9 L17.5 19.7 L16 25.8 L14.5 19.7 L9.1 22.9 L12.3 17.5 L6.2 16 L12.3 14.5 L9.1 9.1 L14.5 12.3 Z"' +
    ' stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>' +
    '<circle cx="16" cy="16" r="1.2" fill="currentColor"/></svg>';
  if (pior){
    var txtV = pior.fmt === "pct" ? pct(pior.valor)
      : pior.valor.toLocaleString("pt-BR",{maximumFractionDigits:1}) + " meses";
    el("sConceito").innerHTML = '<div class="tarocarta">' +
      '<div class="arcano">a carta da vez</div>' + estrelaSvg +
      "<h3>" + esc(pior.nome) + "</h3>" +
      '<div class="veredito" style="color:var(--warn)">' + txtV +
      ' <span style="font-size:var(--t-micro);color:var(--ink3);font-weight:400">· meta ' +
      (pior.fmt === "pct" ? pct(pior.bomAte) : pior.bomDe + "–" + pior.bomAte + " meses") + "</span></div>" +
      "<p style='margin-top:10px'>" + esc(pior.regra) + "</p>" +
      '<div class="fala" style="margin:16px 0 0;text-align:left"><p>Não é sentença, é bússola: ' +
      "essa é a primeira coisa que melhora quando o salário começar a cair.</p>" +
      '<div class="assina">— riquinho</div></div></div>';
  } else {
    el("sConceito").innerHTML = '<div class="tarocarta">' +
      '<div class="arcano">a carta da vez</div>' + estrelaSvg +
      '<h3>C\\u00e9u limpo</h3>' +
      '<p>Todos os indicadores dentro da faixa saud\\u00e1vel. Isso \\u00e9 raro \\u2014 guarda a sensa\\u00e7\\u00e3o.</p></div>';
  }
}

/* ------------------------------------------------------------ genéricos --- */
function faixa(node, cels){
  node.innerHTML = cels.map(function(c){
    return '<div class="cel"><div class="rot">' + esc(c.rot) + "</div>" +
      '<div class="val num ' + (c.cls||"") + '">' + c.val + "</div>" +
      '<div class="pe">' + esc(c.pe||"") + "</div></div>";
  }).join("");
}

var TIP = null;
function mostrarTip(ev, titulo, linhas){
  TIP = TIP || el("tip");
  TIP.innerHTML = '<div class="t">' + esc(titulo) + "</div>" +
    linhas.map(function(l){ return '<div class="l"><span>' + esc(l[0]) + "</span><b>" + l[1] + "</b></div>"; }).join("");
  TIP.classList.add("on");
  var x = ev.clientX + 14, y = ev.clientY - 10;
  if (x + 240 > window.innerWidth) x = ev.clientX - 250;
  TIP.style.left = x + "px"; TIP.style.top = y + "px";
}
function esconderTip(){ if (TIP) TIP.classList.remove("on"); }

/* --------------------------------------------------------- navegação ------ */
var TITULOS = { hoje:"Hoje", pagar:"A pagar", mes:"Fluxo do mês", onde:"Onde vai o dinheiro",
                comp:"Comprometido", saude:"Saúde financeira" };
// O seletor de período só faz sentido nas telas que olham um mês específico.
var USA_PERIODO = { pagar:1, onde:1 };
function irPara(t){
  ESTADO.tela = t;
  document.querySelectorAll(".tela").forEach(function(s){ s.hidden = (s.id !== "tela-" + t); });
  document.querySelectorAll("#nav button").forEach(function(b){
    b.setAttribute("aria-current", String(b.dataset.tela === t)); });
  el("tituloTela").textContent = TITULOS[t];
  el("periodo").style.display = USA_PERIODO[t] ? "inline-flex" : "none";
  window.scrollTo({ top:0, behavior:"instant" });
  try { localStorage.setItem("painel:tela", t); } catch(e){}
}

document.getElementById("nav").addEventListener("click", function(ev){
  var b = ev.target.closest("button[data-tela]"); if (b) irPara(b.dataset.tela);
});
function irParaMes(y){
  ESTADO.mes = y;
  try { localStorage.setItem("painel:mes", y); } catch(e){}
  render();
}
el("mesAnt").addEventListener("click", function(){ irParaMes(deslocarMes(ESTADO.mes || mesCorrente(), -1)); });
el("mesProx").addEventListener("click", function(){ irParaMes(deslocarMes(ESTADO.mes || mesCorrente(),  1)); });
el("mesHoje").addEventListener("click", function(){ irParaMes(mesCorrente()); });
el("pLimpar").addEventListener("click", function(ev){
  ev.stopPropagation();
  gravarPagos(CALC.sel.ym, []); render();
});
el("btnSync").addEventListener("click", sincronizar);
el("btnTema").addEventListener("click", function(){
  var novo = document.documentElement.dataset.tema === "escuro" ? "claro" : "escuro";
  document.documentElement.dataset.tema = novo;
  try { localStorage.setItem("painel:tema", novo); } catch(e){}
  if (CALC.dadosCarregados) render();
});
el("btnSair").addEventListener("click", function(){ location.href = "/logout"; });
document.querySelectorAll("[data-jan]").forEach(function(b){
  b.addEventListener("click", function(){
    ESTADO.janela = b.dataset.jan;
    document.querySelectorAll("[data-jan]").forEach(function(x){
      x.setAttribute("aria-pressed", String(x === b)); });
    renderOnde();
  });
});
document.addEventListener("keydown", function(ev){
  if (ev.target.tagName === "INPUT") return;
  var m = { "1":"hoje","2":"pagar","3":"mes","4":"onde","5":"comp","6":"saude" };
  if (m[ev.key]) irPara(m[ev.key]);
  if (ev.key === "r" || ev.key === "R") sincronizar();
});

/* --------------------------------------------------------------- boot ----- */
try {
  var tm = localStorage.getItem("painel:tema"); if (tm) document.documentElement.dataset.tema = tm;
  var tl = localStorage.getItem("painel:tela"); if (tl && TITULOS[tl]) irPara(tl);
  var mm = localStorage.getItem("painel:mes"); if (mm) ESTADO.mes = mm;
} catch(e){}
iniciar();
</script>
</body>
</html>
`;
