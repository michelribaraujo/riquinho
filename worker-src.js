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

/* ⚠️⚠️ O WORKER RODA EM UTC. O MICHEL VIVE EM AMERICA/SAO_PAULO. ⚠️⚠️
   `new Date()` num Cloudflare Worker é UTC. Das 21h de Brasília em diante o
   painel já achava que era o dia seguinte — e no dia 30/31 isso virava o MÊS
   inteiro: gasto do mês, compromissos, teto do dia, tudo do mês errado.
   Corrigido em 08/09/2026, depois de eu cometer o mesmo erro conversando com
   ele: disse "a fatura vence hoje" às 23:17, porque o container já tinha
   virado o dia. ⛔ Nunca mais usar `new Date()` cru para decidir "hoje". */
const TZ_BR = "America/Sao_Paulo";
function hojeBRISO() {
  // en-CA formata como YYYY-MM-DD, que é exatamente o formato que o painel usa.
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ_BR }).format(new Date());
}
function agoraBR() {
  // Meio-dia UTC: longe o bastante das bordas pra nenhuma conversão virar o dia.
  return new Date(hojeBRISO() + "T12:00:00Z");
}
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
  const hoje = agoraBR();          // ⛔ NUNCA new Date(): o Worker roda em UTC
  const hojeISO = hojeBRISO();
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

  /* Cartões que o Michel decidiu não pagar. Vem da variável CARTOES_CONGELADOS
     (nomes separados por vírgula) e, sem ela, do que ele já me disse. */
  const CONGELADOS = String(env.CARTOES_CONGELADOS || "Cartão Inter")
    .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const CARTAO_CONGELADO = nome =>
    CONGELADOS.some(x => String(nome || "").toLowerCase().includes(x));

  /* ⚠️ CARTÃO MANUAL É RADAR, NÃO É DINHEIRO.
     Michel, 31/08/2026: "o cartão manual só serve pra você controlar no
     Organizze o que está previsto para vir. Não deve refletir em relatório."
     Ele lança ali o que sabe que vem (a Claro, um ajuste de estorno) antes de
     o Open Finance trazer. Quando o banco traz, a cobrança aparece no cartão
     de verdade — e contar os dois é contar a mesma compra duas vezes.
     Então a fatura do cartão manual é PREVISÃO: alimenta o que vem por aí,
     nunca as contas do mês nem a fatura em aberto.
     A marca é o nome, que é como ele mesmo nomeia: "MercadoPago (manual)".
     Dá pra ajustar sem código pela variável CARTOES_PREVISAO. */
  const PREVISAO_NOMES = String(env.CARTOES_PREVISAO || "(manual)")
    .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const CARTAO_PREVISAO = nome =>
    PREVISAO_NOMES.some(x => String(nome || "").toLowerCase().includes(x));

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
  /* ⛔ PASSO SEMPRE 1. Já foi `mesesTotais > 40 ? 2 : 1`, e o passo 2 reintroduz
     em silêncio a mesma truncagem que gerou o caixa de -R$ 31 mil: a fatia volta
     incompleta e ninguém avisa. Se um dia estourar o teto de subrequisições, a
     solução é encurtar o INÍCIO, nunca engordar a fatia. */
  const passo = 1;
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
  function diasEntre(a, b) {
    return Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
  }
  function chave(txt) {
    return String(txt || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/cart(a|ã)o/g, "").replace(/[^a-z0-9]/g, "");
  }
  /* ⚠️ OLHAR A CATEGORIA CERTA. Testei só a categoria RAIZ e a correção não
     pegou em produção: no Organizze do Michel, "Fatura Mercado Pago" NÃO é
     categoria de topo — é SUBcategoria de "Dívidas e empréstimos" (163472211
     sob 144288015). nomeRaiz() devolvia "Dívidas e empréstimos", que não
     começa com "Fatura", e o pagamento seguia invisível. É a mesma raiz que
     aparecia com R$ 12.184,50 em agosto contra R$ 1.885,65 reais: o pagamento
     estava lá dentro o tempo todo. Agora vale a FOLHA ou a raiz — quem nomeia
     a categoria é ele, e ele nomeou na folha. */
  const CAT_FATURA = t => {
    const folha = catNome[t.category_id] || "", raiz = nomeRaiz(t.category_id) || "";
    return /^fatura\b/i.test(folha) ? folha : (/^fatura\b/i.test(raiz) ? raiz : "");
  };
  const EH_PAGTO_FATURA = t => !ehCartao(t) && !!CAT_FATURA(t);
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
                         cat: chave(CAT_FATURA(t)) });
    }
  }
  /* ⚠️ QUAL FATURA ESTE PAGAMENTO QUITA?
     A primeira versão pegava a fatura ABERTA MAIS ANTIGA do cartão. Passou no
     teste (o fixture só tinha faturas de agosto em diante) e errou feio no
     painel dele: a API devolve o ANO INTEIRO, então "a mais antiga ainda
     aberta" era a de dezembro/2025, e o pagamento de agosto foi quitar uma
     fatura de oito meses atrás. A de agosto seguiu cobrando.

     A regra certa é a que a vida usa: um pagamento quita a fatura que estava
     vencendo QUANDO ELE FOI FEITO. Entre as que já tinham fechado na data e
     ainda devem alguma coisa, vence a de valor mais PRÓXIMO do que foi pago —
     e nunca uma que venceu há mais de 45 dias. */
  pagosSoltos.sort((a, b) => a.data < b.data ? -1 : 1);
  for (const p of pagosSoltos) {
    let alvo = null, melhorDist = Infinity;
    for (let i = 0; i < cartoes.length; i++) {
      const c = cartoes[i], nome = chave(c.nome);
      if (!nome || !p.cat.includes(nome)) continue;
      for (const f of (faturasPorCartao[i] || [])) {
        const fecha = String(f.closing_date || "").slice(0, 10);
        const venc  = String(f.date || "").slice(0, 10);
        if (!fecha || fecha > p.data) continue;                  // ainda nem tinha fechado
        if (venc && diasEntre(venc, p.data) > 45) continue;      // fatura velha demais
        const k = c.id + ":" + f.id;
        const resta = Math.abs(f.balance_cents || 0) - (pagoPorFatura[k] || 0);
        if (resta <= 0) continue;
        const dist = Math.abs(resta - p.cents);
        if (dist < melhorDist) { melhorDist = dist; alvo = k; }
      }
    }
    if (alvo) pagoPorFatura[alvo] = (pagoPorFatura[alvo] || 0) + p.cents;
  }

  faturasPorCartao.forEach((lista, i) => {
    const c = cartoes[i];
    (lista || []).forEach(f => {
      const venc = String(f.date || "").slice(0, 10);
      if (!venc) return;
      const fecha = String(f.closing_date || "").slice(0, 10);
      const abre  = String(f.starting_date || "").slice(0, 10);
      /* ⚠️ O QUE SE DEVE É O SALDO, NÃO O VALOR DA FATURA. O Organizze zera
         `balance_cents` quando a fatura é quitada de verdade e mantém
         `amount_cents` como registro histórico. Usar o valor fazia TODA fatura
         paga do ano voltar a aparecer como aberta. */
      const devido = Math.abs(f.balance_cents || 0);
      const pago = Math.max(Math.abs(f.payment_amount_cents || 0),
                            pagoPorFatura[c.id + ":" + f.id] || 0);
      /* ⚠️ NÃO EXIGIR CENTAVO EXATO. A fatura de agosto do MercadoPago fechou
         R$ 10.358,02 no Organizze e o banco cobrou R$ 10.043,72 — R$ 114,30 de
         estorno da Steam que o banco abateu e o Organizze alocou noutro mês.
         Exigir igualdade deixaria um resto fantasma de R$ 314,30 cobrando pra
         sempre. Pagamento que cobre a maior parte da fatura quita a fatura,
         que é como o Organizze e o Michel a enxergam. */
      const aberto = (pago > 0 && pago >= devido * 0.85) ? 0 : Math.max(0, devido - pago);
      /* ⛔ CARTÃO ABANDONADO NÃO TEM CONTA DO MÊS.
         Michel, 31/08/2026, com todas as letras: "eu te disse que iria ignorar
         e não vou pagar a fatura Inter. Vai ficar com nome sujo e futuramente
         renegocio." Ele já tinha me dito antes e eu segui cobrando — o painel
         mostrava R$ 7.772,12 como conta de agosto e fazia o mês parecer
         impagável, escondendo as contas que ele REALMENTE vai pagar.

         Fatura de cartão abandonado é DÍVIDA: continua existindo, aparece em
         Dívidas, acumula rotativo — mas não disputa o caixa do mês. Quando ele
         renegociar, é só tirar o cartão desta lista (ou mudar a variável
         CARTOES_CONGELADOS no Cloudflare, sem tocar em código). */
      const congelada = CARTAO_CONGELADO(c.nome) && aberto > 0;
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
        pagoCents: pago, status, congelada, previsao: CARTAO_PREVISAO(c.nome)
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

  /* ⚠️⚠️ RADAR E CONGELADO NÃO SÃO DINHEIRO GASTO. ⚠️⚠️
     Até 08/09/2026 o flag de previsão e o de congelado só existiam nas FATURAS.
     O resto do painel (gasto do mês, categorias, parcelas, recorrentes, últimos
     lançamentos) continuava somando os dois:
       · o cartão "MercadoPago (manual)" é radar de previsão — contar ele junto
         com o cartão real é contar a MESMA compra duas vezes;
       · o cartão congelado é dívida que ele decidiu não pagar — ela não disputa
         o caixa do mês e não pode inflar "total comprometido".
     Agora o filtro é por ID de cartão, não por nome espalhado pelo código. */
  /* ⛔ O CAMPO AQUI É `nome`, NÃO `name`. `cartoes` é o array JÁ MAPEADO na
     linha 208, que renomeia `name` para `nome`. Em 08/09/2026 eu escrevi
     `c.name` nestas duas linhas: os dois Sets saíam VAZIOS, os dois filtros
     abaixo davam sempre false, e a correção inteira ficou inerte — o painel
     seguiu somando o cartão radar junto com o real (mesma compra duas vezes)
     e a fatura do Inter congelada como gasto do mês. Passou em `node --check`
     e no build porque `undefined` é JavaScript válido. */
  const idsCartaoPrevisao  = new Set(cartoes.filter(c => CARTAO_PREVISAO(c.nome)).map(c => c.id));
  const idsCartaoCongelado = new Set(cartoes.filter(c => CARTAO_CONGELADO(c.nome)).map(c => c.id));
  const EH_PREVISAO_T  = t => ehCartao(t) && idsCartaoPrevisao.has(t.credit_card_id);
  const EH_CONGELADO_T = t => ehCartao(t) && idsCartaoCongelado.has(t.credit_card_id);
  /* Dinheiro que realmente saiu ou vai sair do bolso dele. */
  const REAL_DA_CASA = t => DA_CASA(t) && !EH_PREVISAO_T(t) && !EH_CONGELADO_T(t);

  let saldoOrigem = "api";
  const contas = contasRaw.filter(a => !a.archived && !EH_RADAR(a)).map(a => {
    /* ⚠️ O NOME DO CAMPO É O PROBLEMA. Eu testei balance_cents,
       balance_in_cents e current_balance_cents — e nenhum bateu, então o
       painel caía na soma e mostrava caixa de -R$ 31 mil.
       Agora `balance` também entra. Regra de desempate: no Organizze todo
       dinheiro é INTEIRO em centavos (amount_cents). Se vier com casa
       decimal, é reais e precisa de ×100. */
    let bruto = [a.balance_cents, a.balance_in_cents, a.current_balance_cents,
                 a.saldo_cents, a.current_balance, a.balance].find(v => typeof v === "number");
    /* ⚠️ A REGRA DE ESCALA VALE PRA TODOS, não só pro `balance`. `current_balance`
       entrava na lista sem passar por este teste: se a API devolvesse ele em
       reais, o caixa aparecia 100x menor e ninguém saberia por quê. */
    if (typeof bruto === "number" && !Number.isInteger(bruto)) bruto = Math.round(bruto * 100);
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
      /* ⛔ GASTO É O QUE JÁ ACONTECEU. Lançamento com data futura dentro do mês
         corrente entrava no total e depois esse total era dividido pelos dias JÁ
         CORRIDOS: o "por dia" e a "projeção do mês" inflavam duas vezes. */
      if (d > hojeISO) continue;
      if (!REAL_DA_CASA(t)) continue;
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
    if (EH_CONGELADO_T(t)) continue;  // assinatura em cartão congelado não é custo recorrente dele
    const nome = String(t.description || "").trim();
    if (jaVi.has(nome)) continue;
    const v = Math.abs(t.amount_cents);
    if (temTag(t, "Ass. Essencial")) { recorrente.assinaturas.push({ nome, cents: v, classe: "essencial" }); jaVi.add(nome); }
    else if (temTag(t, "Ass. Luxo"))  { recorrente.assinaturas.push({ nome, cents: v, classe: "luxo" });      jaVi.add(nome); }
    else if (temTag(t, "Despesa Fixa")) { recorrente.fixas.push({ nome, cents: v });     jaVi.add(nome); }
    else if (temTag(t, "Despesa Varíavel")) { recorrente.variaveis.push({ nome, cents: v }); jaVi.add(nome); }
  }

  /* ⚠️⚠️ UMA COBRANÇA NÃO É UMA ASSINATURA.
     O valor de cada recorrente vinha do PRIMEIRO lançamento encontrado na
     janela do mês seguinte. Bastou o Figma cobrar R$ 1.181,66 uma vez (uso de
     IA, que o Michel está contestando) pra essa cobrança virar mensalidade:
     "Ferramentas" apareceu com 915% da média e as assinaturas somaram
     R$ 3.317,36/mês, R$ 39.808,32/ano. Nada disso vai acontecer de novo.

     Agora o valor de um recorrente é a MEDIANA das últimas quatro cobranças
     com o mesmo nome. Mediana ignora o pico sem precisar julgá-lo — e um pico
     é exatamente o que uma cobrança única é. Preço que sobe de verdade (o
     Claude subiu pro MAX) leva um ou dois meses pra assentar na mediana: é o
     preço de não confundir susto com conta fixa, e é o lado certo pra errar. */
  (function mediana() {
    const hist = {};
    for (const t of lanc) {
      if (t.amount_cents >= 0) continue;
      const nome = String(t.description || "").trim();
      if (!nome) continue;
      (hist[nome] = hist[nome] || []).push({ d: String(t.date).slice(0, 10), v: Math.abs(t.amount_cents) });
    }
    const ajustar = item => {
      const h = (hist[item.nome] || []).sort((a, b) => a.d < b.d ? 1 : -1).slice(0, 4).map(x => x.v);
      if (h.length < 3) return;                       // pouca história: mantém o que veio
      h.sort((a, b) => a - b);
      const meio = Math.floor(h.length / 2);
      item.cents = h.length % 2 ? h[meio] : Math.round((h[meio - 1] + h[meio]) / 2);
    };
    recorrente.assinaturas.forEach(ajustar);
    recorrente.fixas.forEach(ajustar);
    recorrente.variaveis.forEach(ajustar);
  })();

  // Dívidas: lançamentos com a tag "Dívida" ainda em aberto, agrupados por descrição-base.
  const dividasMapa = {};
  for (const t of lanc) {
    if (!temTag(t, "Dívida") || t.amount_cents >= 0) continue;
    if (EH_PREVISAO_T(t)) continue;   // radar não é dívida real
    const base = String(t.description).replace(/\s*\(\d+\/\d+\)\s*$/, "").trim();
    const d = String(t.date).slice(0, 10);
    const alvo = dividasMapa[base] || (dividasMapa[base] = {
      nome: base, parcelaCents: Math.abs(t.amount_cents), restam: 0, saldoCents: 0,
      _dataParcela: null, estado: "correndo", juros: null, negativada: false });
    if (!t.paid && d >= hojeISO) {
      alvo.restam++; alvo.saldoCents += Math.abs(t.amount_cents);
      /* ⚠️ A PARCELA QUE SE MOSTRA É A PRÓXIMA A VENCER, não a primeira linha
         que o laço encontrou. Série criada em blocos tem valores diferentes no
         meio (a Claro foi 350 até jun/2027 e 490,46 depois), e a ordem de
         `lanc` não é garantida: sem isto o painel podia exibir o valor de uma
         parcela já paga como se fosse a que ele vai pagar. */
      if (!alvo._dataParcela || d < alvo._dataParcela) {
        alvo._dataParcela = d; alvo.parcelaCents = Math.abs(t.amount_cents);
      }
    }
  }
  /* ⚠️ `restam` e `saldoCents` só enxergam o que está DENTRO da janela de
     transações (hoje + 6 meses). Uma dívida de 33 parcelas devolve restam ≤ 6.
     Antes isso virava "faltam 6" e "R$ X ainda a vencer" na tela, como se fosse
     o total. Não dá pra saber o resto sem alargar a janela (e alargar aumenta o
     risco de truncagem), então o painel passa a DIZER que a conta é parcial em
     vez de mentir um total. */
  const dividas = Object.values(dividasMapa).filter(d => d.restam > 0)
    .map(({ _dataParcela, ...d }) => ({ ...d, janelaMeses: 6, parcial: d.restam >= 6 }));

  // Parcelas de cartão ainda a vencer (compras com total_installments > 1)
  const parcMapa = {};
  for (const t of lanc) {
    if (!ehCartao(t) || !(t.total_installments > 1)) continue;
    if (EH_PREVISAO_T(t) || EH_CONGELADO_T(t)) continue;  // radar e congelado não comprometem caixa
    if (temTag(t, "Dívida")) continue; // já contada como dívida — não contar duas vezes
    const d = String(t.date).slice(0, 10);
    if (d < hojeISO) continue;
    const base = String(t.description).replace(/\s*\d+\/\d+\s*$/, "").trim();
    const alvo = parcMapa[base] || (parcMapa[base] = { desc: base, cents: Math.abs(t.amount_cents), restam: 0 });
    alvo.restam++;
  }
  const parcelas = Object.values(parcMapa).sort((a, b) => b.cents - a.cents);

  const ultimos = lanc
    .filter(t => t.paid && String(t.date).slice(0, 10) <= hojeISO && !INTERNA(t) && !EH_PREVISAO_T(t))
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
