/* Retrato reduzido da API REST v2 do Organizze, com os números conferidos
   no MCP em 31/08/2026. Não é dado inventado: cada valor foi lido do
   Organizze antes de virar teste. */
export const HOJE = "2026-08-31";

export const accounts = [
  { id: 8116851,  name: "Conta inicial",                 archived: true,  type: "other", created_at: "2025-01-13T00:00:00-03:00" },
  { id: 8521975,  name: "Nubank",                        archived: true,  type: "other", created_at: "2025-02-01T00:00:00-03:00" },
  { id: 9488422,  name: "Inter",                         archived: false, type: "checking", created_at: "2025-06-01T00:00:00-03:00" },
  { id: 9489503,  name: "MercadoPago",                   archived: false, type: "checking", created_at: "2025-06-01T00:00:00-03:00" },
  { id: 10017755, name: "Receitas e despesas previstas", archived: false, type: "other", created_at: "2026-05-01T00:00:00-03:00" },
  { id: 10020699, name: "cofrinhos",                     archived: false, type: "other", created_at: "2026-05-01T00:00:00-03:00" },
  { id: 10340530, name: "Conta Nubank",                  archived: false, type: "checking", created_at: "2026-08-01T00:00:00-03:00" }
];

export const credit_cards = [
  { id: 2261580, name: "Cartão Inter",        archived: false, closing_day: 5, due_day: 12, limit_cents: 920000 },
  { id: 2261913, name: "Cartão MercadoPago",  archived: false, closing_day: 1, due_day: 8,  limit_cents: 3190000 },
  { id: 2470295, name: "MercadoPago (manual)",archived: false, closing_day: 2, due_day: 8,  limit_cents: 494000 }
];

export const categories = [
  /* ⚠️ ISTO É O QUE O ORGANIZZE DO MICHEL TEM DE VERDADE: a categoria do
     pagamento de fatura é SUBcategoria de "Dívidas e empréstimos", não é
     categoria de topo. A primeira versão do teste a colocou na raiz — e a
     correção passou aqui e falhou no painel dele. Fixture que não copia a
     forma do dado real testa a fantasia, não o produto. */
  { id: 1, name: "Fatura Mercado Pago", parent_id: 5 },
  { id: 2, name: "Transferências",      parent_id: null },
  { id: 3, name: "Moradia",             parent_id: null },
  { id: 4, name: "Aluguel",             parent_id: 3 },
  { id: 5, name: "Dívidas e empréstimos", parent_id: null },
  { id: 6, name: "Salário",             parent_id: null },
  { id: 7, name: "Ferramentas",         parent_id: null }
];

/* faturas: amount_cents e balance_cents como a API devolve — e
   payment_amount_cents ZERO mesmo na fatura que o Michel já pagou.
   É exatamente esse zero que enganou o painel. */
export const invoices = {
  2261580: [
    { id: 319, date: "2026-08-12", closing_date: "2026-08-05", starting_date: "2026-07-06", amount_cents: -777212, balance_cents: -777212, payment_amount_cents: 0 },
    { id: 320, date: "2026-09-12", closing_date: "2026-09-05", starting_date: "2026-08-06", amount_cents: -5513,   balance_cents: -5513,   payment_amount_cents: 0 }
  ],
  2261913: [
    /* ⚠️ FATURAS ANTIGAS, JÁ PAGAS. A API devolve o ANO INTEIRO, e é isso que
       derrubou a primeira correção: o pagamento de agosto foi parar na fatura
       de dezembro/2025, "a mais antiga ainda aberta". Repare que o Organizze
       ZERA o balance quando a fatura é quitada de verdade, mas mantém o amount
       como registro — quem manda é o balance. */
    { id: 312, date: "2026-01-07", closing_date: "2025-12-31", starting_date: "2025-12-01", amount_cents: -423038, balance_cents: 0, payment_amount_cents: 0 },
    { id: 318, date: "2026-07-07", closing_date: "2026-06-30", starting_date: "2026-05-31", amount_cents: -484990, balance_cents: 0, payment_amount_cents: 0 },
    { id: 319, date: "2026-08-08", closing_date: "2026-08-01", starting_date: "2026-07-02", amount_cents: -1035802, balance_cents: -1035802, payment_amount_cents: 0 },
    { id: 320, date: "2026-09-08", closing_date: "2026-09-01", starting_date: "2026-08-02", amount_cents: -1189937, balance_cents: -1189937, payment_amount_cents: 0 },
    { id: 321, date: "2026-10-08", closing_date: "2026-10-01", starting_date: "2026-09-02", amount_cents: -280876,  balance_cents: -280876,  payment_amount_cents: 0 }
  ],
  2470295: [
    { id: 319, date: "2026-08-08", closing_date: "2026-08-02", starting_date: "2026-07-03", amount_cents: 0,       balance_cents: 0,       payment_amount_cents: 0 },
    { id: 320, date: "2026-09-08", closing_date: "2026-09-02", starting_date: "2026-08-03", amount_cents: -100367, balance_cents: -100367, payment_amount_cents: 0 }
  ]
};

export const transactions = [
  // O PAGAMENTO DA FATURA. Lançamento comum, nenhum campo aponta pra fatura.
  { id: 3227677547, description: "Pagamento da fatura MercadoPago (agosto/2026)",
    date: "2026-08-06", paid: true, amount_cents: -1004372, account_id: 9489503, category_id: 1, tags: [] },
  // compra no cartão: não é movimento de conta
  { id: 3227677565, description: "Aluguel", date: "2026-08-06", paid: true,
    amount_cents: -261426, account_id: null, credit_card_id: 2261913, credit_card_invoice_id: 320, category_id: 4, tags: [] },
  // transferência interna: não é renda nem gasto
  { id: 3227678167, description: "Saída da caixinha Emergência", date: "2026-08-06", paid: true,
    amount_cents: -1004300, account_id: 10020699, category_id: 2, tags: [{ name: "Transferência Interna" }] },
  { id: 3227678168, description: "Entrada no MercadoPago", date: "2026-08-06", paid: true,
    amount_cents: 1004300, account_id: 9489503, category_id: 2, tags: [{ name: "Transferência Interna" }] },
  // previsão de setembro, na conta-radar: alimenta "a pagar", não é saldo
  { id: 3188477621, description: "Aluguel", date: "2026-09-07", paid: false,
    amount_cents: -253812, account_id: 10017755, category_id: 4, tags: [{ name: "Despesa Fixa" }] },
  // renda esperada: dois meses na janela, um salário por mês
  { id: 3231308364, description: "Salário Komuh (PJ) — EXPECTATIVA", date: "2026-10-05", paid: false,
    amount_cents: 830000, account_id: 10017755, category_id: 6, tags: [] },
  { id: 3231311718, description: "Ajuda de custo — EXPECTATIVA", date: "2026-10-05", paid: false,
    amount_cents: 15000, account_id: 10017755, category_id: 6, tags: [] },
  { id: 3231308379, description: "Salário Komuh (PJ) — EXPECTATIVA", date: "2026-11-05", paid: false,
    amount_cents: 830000, account_id: 10017755, category_id: 6, tags: [] },
  { id: 3231311721, description: "Ajuda de custo — EXPECTATIVA", date: "2026-11-05", paid: false,
    amount_cents: 15000, account_id: 10017755, category_id: 6, tags: [] },
  /* Figma: quatro cobranças da mensalidade e UMA cobrança extra de uso de IA
     (a que o Michel está contestando). A recorrente é R$ 105,37, nunca a de
     R$ 1.181,66 — e é isso que o teste cobra. */
  { id: 500001, description: "FIGMA", date: "2026-05-21", paid: true, amount_cents: -10537, account_id: null, credit_card_id: 2261913, credit_card_invoice_id: 316, category_id: 7, tags: [{ name: "Ass. Essencial" }] },
  { id: 500002, description: "FIGMA", date: "2026-06-21", paid: true, amount_cents: -10537, account_id: null, credit_card_id: 2261913, credit_card_invoice_id: 317, category_id: 7, tags: [{ name: "Ass. Essencial" }] },
  { id: 500003, description: "FIGMA", date: "2026-07-21", paid: true, amount_cents: -10537, account_id: null, credit_card_id: 2261913, credit_card_invoice_id: 319, category_id: 7, tags: [{ name: "Ass. Essencial" }] },
  { id: 500004, description: "FIGMA", date: "2026-08-21", paid: true, amount_cents: -118166, account_id: null, credit_card_id: 2261913, credit_card_invoice_id: 320, category_id: 7, tags: [{ name: "Ass. Essencial" }] },
  { id: 500005, description: "FIGMA", date: "2026-09-21", paid: false, amount_cents: -10537, account_id: null, credit_card_id: 2261913, credit_card_invoice_id: 321, category_id: 7, tags: [{ name: "Ass. Essencial" }] },
  // lançamento de conta ARQUIVADA: existe na API, não é vida atual
  { id: 999001, description: "Coisa velha da Conta inicial", date: "2026-08-10", paid: true,
    amount_cents: -5000000, account_id: 8116851, category_id: 5, tags: [] }
];
