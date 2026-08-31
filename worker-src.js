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

    /* Diagnóstico: devolve /accounts como a API mandou, sem tocar em nada.
       Existe porque eu já errei TRÊS nomes de campo tentando adivinhar onde
       o Organizze guarda o saldo. É a conta do próprio Michel, no Worker
       dele, atrás da mesma senha — e some quando o saldo estiver certo. */
    if (p === "/api/bruto") {
      if (!autenticado) return json({ erro: "sessao" }, 401);
      try {
        const d = await montarDados(env);
        return json({
          inicio: d.inicioSaldo, hoje: d.hoje,
          fatiasLidas: d.fatiasLidas, lancLidos: d.lancLidos,
          camposConta: d.camposConta,
          camposLanc: d.camposLanc, camposLancCartao: d.camposLancCartao,
          fatias: d.contagemFatia,
          accounts: await org(env, "/accounts"),
          auditoria: d.auditoria
        });
      } catch (e) {
        return json({ erro: String(e && e.message || e) }, 502);
      }
    }

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

/* ⚠️⚠️ O BUG QUE ENVENENOU O PAINEL INTEIRO ⚠️⚠️
   Durante semanas isto foi `t.account_type === "CreditCard"`. A API REST do
   Organizze NÃO DEVOLVE `account_type` em /transactions — ela devolve
   `credit_card_id`. Ou seja: o teste era SEMPRE FALSO e toda compra de
   cartão passou a contar como movimento de conta bancária.

   Quatro sintomas, uma causa (26/08/2026):
     · caixa de -R$ 31.372,77 quando o real era +R$ 2.941,23 — cada compra
       de cartão era descontada do saldo do banco
     · "A pagar" com 73 contas e R$ 27.646,25 num mês cujo gasto real foi
       R$ 12.625,57 — cada compra virava uma conta a pagar, e a fatura era
       contada por cima
     · gasto do mês inflado na mesma proporção
     · a lista de parcelas SEMPRE VAZIA, porque o teste invertido descartava
       justamente as compras parceladas

   Nunca mais testar tipo de conta por um campo que a API não documenta.
   Cartão se reconhece pelo credit_card_id.                               */
function ehCartao(t) {
  return !!(t.credit_card_id || t.credit_card_invoice_id || t.account_type === "CreditCard");
}

async function montarDados(env) {
  const hoje = new Date();
  const hojeISO = iso(hoje);
  const ano = hoje.getFullYear(), mes = hoje.getMonth() + 1;
  /* ⚠️ O INÍCIO NÃO PODE SER UM CHUTE. A soma do saldo só fecha se ela
     começar exatamente onde os dados começam. Por isso o início nasce da
     conta mais antiga do próprio Organizze (inclusive as arquivadas, que
     guardam o histórico), arredondado pro primeiro dia do mês. */
  let inicio = env.INICIO || null;

  const [contasRaw, cartoesRaw, categoriasRaw] = await Promise.all([
    org(env, "/accounts"),
    org(env, "/credit_cards"),
    org(env, "/categories")
  ]);

  if (!inicio) {
    const nascimentos = (contasRaw || []).map(a => String(a.created_at || "").slice(0, 10))
                                         .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    inicio = nascimentos.length ? nascimentos[0].slice(0, 7) + "-01" : "2024-01-01";
  }

  const cartoes = cartoesRaw.filter(c => !c.archived).map(c => ({
    id: c.id, nome: c.name, fechamento: c.closing_day, vencimento: c.due_day,
    limiteCents: c.limit_cents || null
  }));

  // Faturas de cada cartão (ano corrente). O SALDO só se decide depois de ler
  // os lançamentos — é lá que estão os pagamentos de fatura.
  const faturasPorCartao = await Promise.all(cartoes.map(c => org(env, `/credit_cards/${c.id}/invoices`)));
  const faturas = [];
  /* Transações: do INICIO até 6 meses à frente, UM MÊS POR VEZ.
     ⚠️ A doc do Organizze diz, com todas as letras, que "a paginação de
     movimentações é feita com os parâmetros start_date e end_date". Ou seja:
     não existe page/per_page — quem tem que estreitar a janela é quem pergunta.
     Fatias de 3 meses chegavam a 650 lançamentos e voltavam incompletas em
     silêncio: o painel somava um pedaço do extrato e anunciava caixa de
     -R$ 31 mil onde o Organizze mostrava +R$ 3 mil.
     Um mês por vez é a única janela que o Organizze garante inteira. */
  const fim = iso(addMeses(hoje, 6));
  /* O Worker tem teto de subrequisições. Um mês por fatia é o ideal; se o
     histórico for longo demais pra caber, o passo abre pra 2 meses — sempre
     nos meses antigos, que são os mais magros. */
  const mesesTotais = (Number(fim.slice(0, 4)) - Number(inicio.slice(0, 4))) * 12
                    + (Number(fim.slice(5, 7)) - Number(inicio.slice(5, 7))) + 1;
  const passo = mesesTotais > 40 ? 2 : 1;
  const fatias = [];
  let cursor = new Date(inicio + "T12:00:00");
  while (iso(cursor) < fim) {
    const prox = addMeses(cursor, passo);
    fatias.push([iso(cursor), iso(prox) < fim ? iso(prox) : fim]);
    cursor = prox;
  }
  const contagemFatia = [];
  const vistos = new Set();
  const lanc = [];
  for (let i = 0; i < fatias.length; i += 6) {          // 6 meses por vez: rápido sem estourar o limite de subrequests
    const lote = fatias.slice(i, i + 6);
    const blocos = await Promise.all(lote.map(([a, b]) => org(env, `/transactions?start_date=${a}&end_date=${b}`)));
    blocos.forEach((bloco, k) => {
      contagemFatia.push({ de: lote[k][0], ate: lote[k][1], n: (bloco || []).length });
      (bloco || []).forEach(t => { if (!vistos.has(t.id)) { vistos.add(t.id); lanc.push(t); } });
    });
  }

  const catNome = {}; (categoriasRaw || []).forEach(c => { catNome[c.id] = c.name; });
  const catPai  = {}; (categoriasRaw || []).forEach(c => { catPai[c.id] = c.parent_id; });
  function nomeRaiz(id) { const p = catPai[id]; return catNome[p] || catNome[id] || "Sem categoria"; }
  function temTag(t, nome) { return (t.tags || []).some(x => (x.name || x) === nome); }
  const INTERNA = t => temTag(t, "Transferência Interna") || nomeRaiz(t.category_id) === "Transferências";

  /* ⚠️⚠️ FATURA PAGA NÃO É FATURA EM ABERTO.
     O painel anunciava R$ 29.639,29 de fatura e R$ 18.130,14 a pagar em
     agosto. A fatura de agosto do MercadoPago (R$ 10.358,02) JÁ ESTAVA PAGA —
     o próprio Organizze mostrava só os R$ 7.772,12 do Inter. O erro: o painel
     lia `balance_cents` e nunca perguntava se alguém tinha pagado.

     E `balance_cents` NÃO zera quando a fatura é quitada (a de agosto continua
     -R$ 10.358,02 mesmo paga). Então o pagamento se descobre por dois caminhos,
     e vale o maior: o campo `payment_amount_cents` da própria fatura, e os
     lançamentos que apontam pra ela via `paid_credit_card_invoice_id`.
     ⚠️ O id da fatura se repete entre cartões (o 319 existe nos dois) — casar
     só pelo id mistura as faturas. Tem que casar id E cartão. */
  /* ⚠️ A API NÃO LINKA O PAGAMENTO À FATURA. Eu apostei que `paid_credit_card_id`
     resolveria e o painel continuou cobrando uma fatura já paga. O pagamento
     real do Michel é isto, e mais nada:
        "Pagamento da fatura MercadoPago (agosto/2026)" · -R$ 10.043,72
        06/08 · conta MercadoPago · categoria "Fatura Mercado Pago"
     Um lançamento comum. Nenhum campo aponta pra fatura.
     Então o vínculo se faz pelo que EXISTE: categoria raiz começando com
     "Fatura", em conta bancária. É convenção do próprio Michel e está no
     Organizze há meses. */
  function chave(txt) {
    return String(txt || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/cart(a|ã)o/g, "").replace(/[^a-z0-9]/g, "");
  }
  const EH_PAGTO_FATURA = t => !ehCartao(t) && /^fatura\b/i.test(nomeRaiz(t.category_id) || "");
  const PAGA_FATURA = t => !!(t.paid_credit_card_id || t.paid_credit_card_invoice_id) || EH_PAGTO_FATURA(t);

  /* Cada pagamento vai pro cartão cujo nome cabe dentro do nome da categoria
     ("Fatura Mercado Pago" ⊃ "MercadoPago"), e dentro do cartão vai pra fatura
     mais ANTIGA ainda aberta que já tinha fechado na data do pagamento. */
  const pagoPorFatura = {};
  const pagosSoltos = [];
  for (const t of lanc) {
    if (t.paid_credit_card_invoice_id) {
      const k = (t.paid_credit_card_id || "?") + ":" + t.paid_credit_card_invoice_id;
      pagoPorFatura[k] = (pagoPorFatura[k] || 0) + Math.abs(t.amount_cents || 0);
      continue;
    }
    if (EH_PAGTO_FATURA(t) && t.amount_cents < 0) {
      pagosSoltos.push({ data: String(t.date).slice(0, 10), cents: Math.abs(t.amount_cents),
                         cat: chave(nomeRaiz(t.category_id)) });
    }
  }
  pagosSoltos.sort((a, b) => a.data < b.data ? -1 : 1);
  for (const p of pagosSoltos) {
    let alvo = null;
    for (let i = 0; i < cartoes.length; i++) {
      const c = cartoes[i], nome = chave(c.nome);
      if (!nome || !p.cat.includes(nome)) continue;
      const lista = (faturasPorCartao[i] || [])
        .filter(f => String(f.closing_date || "").slice(0, 10) <= p.data)
        .filter(f => (pagoPorFatura[c.id + ":" + f.id] || 0) < Math.abs(f.amount_cents || 0))
        .filter(f => Math.abs(f.amount_cents || 0) > 0)
        .sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
      if (lista.length && (!alvo || chave(c.nome).length > alvo.peso)) {
        alvo = { k: c.id + ":" + lista[0].id, peso: nome.length };
      }
    }
    if (alvo) pagoPorFatura[alvo.k] = (pagoPorFatura[alvo.k] || 0) + p.cents;
  }

  faturasPorCartao.forEach((lista, i) => {
    const c = cartoes[i];
    (lista || []).forEach(f => {
      const venc = String(f.date || "").slice(0, 10);
      if (!venc) return;
      const fecha = String(f.closing_date || "").slice(0, 10);
      const abre  = String(f.starting_date || "").slice(0, 10);
      const devido = Math.abs(f.amount_cents || 0);
      const pago = Math.max(Math.abs(f.payment_amount_cents || 0),
                            pagoPorFatura[c.id + ":" + f.id] || 0);
      /* ⚠️ NÃO EXIGIR CENTAVO EXATO. A fatura de agosto do MercadoPago fechou
         R$ 10.358,02 no Organizze e o banco cobrou R$ 10.043,72 — R$ 114,30 de
         estorno da Steam que o banco abateu e o Organizze alocou noutro mês.
         Exigir igualdade deixaria um resto fantasma de R$ 314,30 cobrando pra
         sempre. Pagamento que cobre a maior parte da fatura quita a fatura,
         que é como o Organizze e o Michel a enxergam. */
      const aberto = (pago > 0 && pago >= devido * 0.85) ? 0 : Math.max(0, devido - pago);
      let status;
      if (abre && abre > hojeISO) status = "futura";
      else if (fecha && hojeISO <= fecha) status = "emFormacao";
      else if (aberto === 0) status = "paga";
      else if (venc < hojeISO) status = "vencida";
      else status = "fechada";
      faturas.push({
        cartaoId: c.id, mes: venc.slice(0, 7), vencimento: venc,
        valorCents: f.amount_cents || 0,
        // saldo = o que AINDA se deve, com sinal de despesa. Fatura paga vira 0
        // e some sozinha de todo filtro que já existia no painel.
        saldoCents: -aberto,
        pagoCents: pago, status
      });
    });
  });


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
  /* ⚠️⚠️ CONTA-RADAR NÃO É DINHEIRO.
     O Michel: "ele fala que tenho -31k em conta (o que é mentira) e cita 5
     contas, sendo que só tenho MercadoPago, Nubank e Inter."

     As outras duas são manuais: `cofrinhos` (que TEM dinheiro de verdade) e
     `Receitas e despesas previstas` — que NÃO tem saldo nenhum. Ela existe
     só pra estacionar previsão, e é regra do próprio Michel: marcar algo
     como pago ali sem mover dinheiro deixa ela negativa. Meses disso viraram
     um buraco de dezenas de milhares que o painel somava no caixa.

     O Organizze mostra R$ 0,00 pra ela. O painel tem que ignorá-la. */
  const EH_RADAR = a => /receitas?\s+e\s+despesas?\s+previst/i.test(a.name || "");

  /* ⚠️ CONTA ARQUIVADA NÃO É VIDA ATUAL. O Organizze guarda o histórico dela
     (a `Conta inicial`, o Nubank antigo, a carteira do iFood) e a API devolve
     esses lançamentos junto com os de hoje. Eles não podem virar gasto do mês
     nem conta a pagar. A conta-radar (`Receitas e despesas previstas`) FICA:
     ela não é dinheiro, mas é justamente onde moram as previsões. */
  const idsContaViva = new Set(contasRaw.filter(a => !a.archived).map(a => a.id));
  const idsCartaoVivo = new Set(cartoes.map(c => c.id));
  const DA_CASA = t => ehCartao(t)
    ? idsCartaoVivo.has(t.credit_card_id)
    : idsContaViva.has(t.account_id);

  let saldoOrigem = "api";
  const contas = contasRaw.filter(a => !a.archived && !EH_RADAR(a)).map(a => {
    /* ⚠️ O NOME DO CAMPO É O PROBLEMA. Eu testei balance_cents,
       balance_in_cents e current_balance_cents — e nenhum bateu, então o
       painel caía na soma e mostrava caixa de -R$ 31 mil.
       Agora `balance` também entra. Regra de desempate: no Organizze todo
       dinheiro é INTEIRO em centavos (amount_cents). Se vier com casa
       decimal, é reais e precisa de ×100. */
    let bruto = [a.balance_cents, a.balance_in_cents, a.current_balance_cents,
                 a.saldo_cents, a.current_balance].find(v => typeof v === "number");
    if (bruto === undefined && typeof a.balance === "number") {
      bruto = Number.isInteger(a.balance) ? a.balance : Math.round(a.balance * 100);
    }
    let s = (bruto !== undefined) ? bruto : null;
    if (s === null) {
      saldoOrigem = "somado";
      s = 0;
      for (const t of lanc) {
        if (ehCartao(t)) continue;
        if (t.account_id === a.id && t.paid) s += t.amount_cents;
      }
    }
    return { id: a.id, nome: a.name, manual: a.type === "other", saldoCents: s };
  });

  /* AUDITORIA — o painel tem que conseguir provar o próprio caixa.
     Enquanto o saldo for somado (a API não devolve saldo pronto), cada conta
     carrega de onde veio o número dela: quantos lançamentos entraram, quantos
     ficaram de fora e quais foram os maiores. Sem isso, um caixa errado é
     indistinguível de um caixa certo — e já custou dias. */
  const auditoria = contas.map(c => {
    let n = 0, nPagos = 0, nCartao = 0;
    const pesos = [];
    for (const t of lanc) {
      if (t.account_id !== c.id) continue;
      n++;
      if (ehCartao(t)) { nCartao++; continue; }
      if (!t.paid) continue;
      nPagos++;
      pesos.push({ d: String(t.date).slice(0, 10), desc: t.description, cents: t.amount_cents });
    }
    pesos.sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents));
    return { id: c.id, nome: c.nome, saldoCents: c.saldoCents, n, nPagos, nCartao, maiores: pesos.slice(0, 6) };
  });

  // Contas a pagar / a receber ainda em aberto (não pagas), em conta bancária.
  // ⚠️ ESTE LIMITE E O HORIZONTE DE projetar() ANDAM JUNTOS. Se aqui for menor,
  // o fim da linha do saldo fica artificialmente otimista: as faturas continuam
  // aparecendo (vêm de outra consulta, 6 meses), mas as contas de Pix/boleto somem.
  // projetar() olha 92 dias — então aqui são 3 meses. Mexeu num, mexe no outro.
  const limite = iso(addMeses(hoje, 3));
  const aPagar = [], aReceber = [];
  for (const t of lanc) {
    if (t.paid || ehCartao(t)) continue;
    if (!DA_CASA(t)) continue;
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
      if (!DA_CASA(t)) continue;
      const raiz = nomeRaiz(t.category_id);
      if (t.amount_cents > 0) {
        bruta += t.amount_cents;
        if (INTERNA(t)) interna += t.amount_cents; else renda += t.amount_cents;
        continue;
      }
      if (INTERNA(t)) continue;
      /* ⚠️ PAGAMENTO DE FATURA NÃO É GASTO NOVO — a compra já foi contada
         quando aconteceu. Antes isto dependia da categoria começar com
         "Fatura", e bastava um pagamento categorizado como "Dívidas e
         empréstimos" pra furar: em agosto/2026 essa categoria apareceu com
         R$ 12.184,50 quando o real era R$ 1.885,65, e o gasto do mês inteiro
         subiu de R$ 22.631,59 pra R$ 32.930,44. Categoria é escolha do Michel;
         o vínculo com a fatura é fato da API. */
      if (PAGA_FATURA(t)) continue;
      if (raiz && raiz.toLowerCase().indexOf("fatura") === 0) continue;
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
    if (!ehCartao(t) || !(t.total_installments > 1)) continue;
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
    /* Só os NOMES dos campos que /accounts devolveu — nenhum valor. É o
       suficiente pra descobrir onde o Organizze guarda o saldo, e some da
       tela assim que saldoOrigem virar "api". */
    camposConta: Object.keys(contasRaw[0] || {}),
    auditoria,
    fatiasLidas: contagemFatia.length, lancLidos: lanc.length, contagemFatia,
    camposLanc: Object.keys(lanc.find(t => !ehCartao(t)) || {}),
    camposLancCartao: Object.keys(lanc.find(t => ehCartao(t)) || {}),
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
