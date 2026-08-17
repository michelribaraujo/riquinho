/* ------------------------------------------------------------------
   RETRATO DE DEMONSTRAÇÃO — 17/08/2026
   Todos os números aqui vieram do Organizze do Michel nesta data.
   Nada foi inventado. Serve só pra ver o painel funcionando offline.
   Na versão publicada, este objeto é substituído pelo /api/bootstrap.
------------------------------------------------------------------- */
window.DADOS_DEMO = {
  origem: "demo",
  geradoEm: "2026-08-17T14:10:00-03:00",
  hoje: "2026-08-17",
  mesRef: { ano: 2026, mes: 8 },

  contas: [
    { id: 9488422,  nome: "Inter",                         manual: false, saldoCents: 0 },
    { id: 9489503,  nome: "MercadoPago",                   manual: false, saldoCents: 12619 },
    { id: 10017755, nome: "Receitas e despesas previstas",  manual: true,  saldoCents: 0 },
    { id: 10020699, nome: "cofrinhos",                      manual: true,  saldoCents: 314146 },
    { id: 10340530, nome: "Conta Nubank",                   manual: false, saldoCents: 0 }
  ],

  cartoes: [
    { id: 2261580, nome: "Cartão Inter",        fechamento: 5, vencimento: 12, limiteCents: 920000 },
    { id: 2261913, nome: "Cartão MercadoPago",  fechamento: 1, vencimento: 8,  limiteCents: null },
    { id: 2470295, nome: "MercadoPago (manual)", fechamento: 1, vencimento: 8, limiteCents: null }
  ],

  // saldoCents != 0  =>  fatura em aberto de verdade (regra T3: nunca usar open_invoice_amount)
  faturas: [
    { cartaoId: 2261580, mes: "2026-08", vencimento: "2026-08-12", valorCents: -777212, saldoCents: -777212, status: "vencida", congelada: true },
    { cartaoId: 2261580, mes: "2026-09", vencimento: "2026-09-12", valorCents: 0,       saldoCents: 0,       status: "emFormacao" },
    { cartaoId: 2261913, mes: "2026-09", vencimento: "2026-09-08", valorCents: -727622, saldoCents: -727622, status: "emFormacao" },
    { cartaoId: 2470295, mes: "2026-09", vencimento: "2026-09-08", valorCents: -151105, saldoCents: -151105, status: "emFormacao" },
    { cartaoId: 2261913, mes: "2026-10", vencimento: "2026-10-08", valorCents: -188943, saldoCents: -188943, status: "futura" },
    { cartaoId: 2470295, mes: "2026-10", vencimento: "2026-10-08", valorCents: -167847, saldoCents: -167847, status: "futura" },
    { cartaoId: 2261913, mes: "2026-11", vencimento: "2026-11-08", valorCents: -170154, saldoCents: -170154, status: "futura" },
    { cartaoId: 2470295, mes: "2026-11", vencimento: "2026-11-08", valorCents: -166578, saldoCents: -166578, status: "futura" },
    { cartaoId: 2261913, mes: "2026-12", vencimento: "2026-12-08", valorCents: -44910,  saldoCents: -44910,  status: "futura" },
    { cartaoId: 2470295, mes: "2026-12", vencimento: "2026-12-08", valorCents: -149849, saldoCents: -149849, status: "futura" }
  ],

  // Contas a pagar em aberto (45 dias) — get_upcoming_bills
  // A PAGAR = só o que sai da CONTA (Pix/boleto). Assinatura de cartão não entra:
  // ela já vive dentro da fatura, e a fatura entra como uma linha só.
  aPagar: [
    { data: "2026-09-05", desc: "Contribuição pro terreiro",                cents: -10000,  grupo: "fixa" },
    { data: "2026-09-05", desc: "Linha de Crédito MercadoPago",             cents: -43965,  grupo: "divida" },
    { data: "2026-09-05", desc: "Parcela Nubank",                           cents: -25508,  grupo: "divida" },
    { data: "2026-09-07", desc: "Aluguel",                                  cents: -253812, grupo: "fixa" },
    { data: "2026-09-10", desc: "Condomínio",                               cents: -48000,  grupo: "fixa" },
    { data: "2026-09-14", desc: "Luz",                                      cents: -29524,  grupo: "variavel", nota: "o João reembolsa metade" },
    { data: "2026-09-20", desc: "Claro multi",                              cents: -35000,  grupo: "variavel" },
    { data: "2026-09-30", desc: "DAS parcelamento Simples Nacional (2/33)", cents: -30055,  grupo: "divida" },
    { data: "2026-09-30", desc: "Parcelamento Dívida Ativa PGFN (2/25)",    cents: -30218,  grupo: "divida" },

    { data: "2026-10-05", desc: "Contribuição pro terreiro",                cents: -10000,  grupo: "fixa" },
    { data: "2026-10-05", desc: "Linha de Crédito MercadoPago",             cents: -43965,  grupo: "divida" },
    { data: "2026-10-05", desc: "Parcela Nubank",                           cents: -25508,  grupo: "divida" },
    { data: "2026-10-07", desc: "Aluguel",                                  cents: -253812, grupo: "fixa" },
    { data: "2026-10-10", desc: "Condomínio",                               cents: -48000,  grupo: "fixa" },
    { data: "2026-10-14", desc: "Luz",                                      cents: -29524,  grupo: "variavel", nota: "o João reembolsa metade" },
    { data: "2026-10-20", desc: "Claro multi",                              cents: -35000,  grupo: "variavel" },
    { data: "2026-10-30", desc: "DAS parcelamento Simples Nacional (3/33)", cents: -30055,  grupo: "divida" },
    { data: "2026-10-30", desc: "Parcelamento Dívida Ativa PGFN (3/25)",    cents: -30218,  grupo: "divida" },

    { data: "2026-11-05", desc: "Contribuição pro terreiro",                cents: -10000,  grupo: "fixa" },
    { data: "2026-11-05", desc: "Linha de Crédito MercadoPago",             cents: -43965,  grupo: "divida" },
    { data: "2026-11-05", desc: "Parcela Nubank",                           cents: -25508,  grupo: "divida" },
    { data: "2026-11-07", desc: "Aluguel",                                  cents: -253812, grupo: "fixa" },
    { data: "2026-11-10", desc: "Condomínio",                               cents: -48000,  grupo: "fixa" },
    { data: "2026-11-14", desc: "Luz",                                      cents: -29524,  grupo: "variavel", nota: "o João reembolsa metade" }
  ],

  aReceber: [
    { data: "2026-10-05", desc: "Salário Komuh (PJ)",           cents: 830000, expectativa: true },
    { data: "2026-10-05", desc: "Ajuda de custo computador",    cents: 15000,  expectativa: true },
    { data: "2026-11-05", desc: "Salário Komuh (PJ)",           cents: 830000, expectativa: true },
    { data: "2026-11-05", desc: "Ajuda de custo computador",    cents: 15000,  expectativa: true }
  ],

  // Gasto do mês por categoria — get_categories_report (inclui compras de cartão,
  // exclui pagamento de fatura e transferência interna)
  gastoMes: {
    totalCents: 1094534,
    categorias: [
      { nome: "Moradia",             cents: 393940, sub: [["Aluguel",261426],["Claro Multi",52500],["Condomínio",48000],["Energia",32014]] },
      { nome: "Dívidas",             cents: 188565, sub: [["DAS/PGFN",60273],["Linha de crédito",43873],["Nubank",25513],["Quitação MP",82929]] },
      { nome: "Ferramentas",         cents: 168687, sub: [["Claude",102350],["Figma",10537],["Agilize",12900],["Google Business",9800]] },
      { nome: "Alimentação",         cents: 84124,  sub: [["Lanches",11786],["Feira",11249],["Janta",10849],["Supermercado",7536],["Almoço",3169]] },
      { nome: "Lazer",               cents: 56124,  sub: [["Jogos",18040],["Lugares e rolês",13500],["Bares",9400],["Apple One",7690],["Restaurantes",5104],["Spotify",2390]] },
      { nome: "Transporte",          cents: 48916,  sub: [["Uber e 99",46726]] },
      { nome: "Prevenção e saúde",   cents: 41890,  sub: [["Wellhub",23990],["Bike ZiYou",17900]] },
      { nome: "Outros",              cents: 36066,  sub: [] },
      { nome: "Religião",            cents: 29500,  sub: [["Guias e itens",19500],["Terreiro",10000]] },
      { nome: "Pets",                cents: 24694,  sub: [["Ração",14198],["Plano de saúde",10496]] },
      { nome: "Saúde",               cents: 11965,  sub: [["Farmácia",11965]] },
      { nome: "Roupas",              cents: 10063,  sub: [] }
    ]
  },

  // Gasto por MÊS — é isto que o seletor de período do topo consulta.
  // Valores reais do Organizze (get_categories_evolution).
  meses: {
    "2026-05": { gastoTotal: 2189307, renda: 1120000 },
    "2026-06": { gastoTotal: 1400440, renda: 396773 },
    "2026-07": { gastoTotal: 4105107, renda: 3000000 },
    "2026-08": { gastoTotal: 1094534, renda: 603560 }
  },

  // Evolução mensal por categoria — get_categories_evolution (mai → ago/2026)
  historico: {
    meses: ["2026-05", "2026-06", "2026-07", "2026-08"],
    categorias: [
      { nome: "Dívidas",           serie: [683379, 156574, 1754570, 188565] },
      { nome: "Moradia",           serie: [415422, 380382, 208227, 393940] },
      { nome: "Alimentação",       serie: [171260, 155438, 473892, 84124] },
      { nome: "Lazer",             serie: [73955, 163972, 427341, 56124] },
      { nome: "Compras",           serie: [225546, 198213, 255401, 0] },
      { nome: "Outros",            serie: [289519, 128639, 220739, 36066] },
      { nome: "Ferramentas",       serie: [19600, 0, 187166, 168687] },
      { nome: "Saúde",             serie: [17256, 86446, 171182, 11965] },
      { nome: "Prevenção e saúde", serie: [85984, 33940, 108770, 41890] },
      { nome: "Transporte",        serie: [64136, 19675, 130442, 48916] },
      { nome: "Cuidados pessoais", serie: [99702, 49156, 39125, 0] },
      { nome: "Pets",              serie: [33548, 16005, 110062, 24694] },
      { nome: "Religião",          serie: [10000, 12000, 10500, 29500] },
      { nome: "Roupas",            serie: [0, 0, 7690, 10063] }
    ],
    gastoTotal:  [2189307, 1400440, 4105107, 1094534],
    rendaLiquida:[1120000, 396773, 3000000, 603560]
  },

  // Receita do mês, já sem transferência interna
  // 19.073,14 (receitas) − 13.037,54 (tag Transferência Interna) = 6.035,60
  rendaMesCents: 603560,
  rendaMesBruta: 1907314,
  transferenciaInternaCents: 1303754,

  // Custo recorrente contratado (o que sai todo mês sem você decidir nada)
  recorrente: {
    fixas: [
      { nome: "Aluguel",              cents: 253812 },
      { nome: "Condomínio",           cents: 48000 },
      { nome: "Ração da Lizzy",       cents: 14502 },
      { nome: "Contribuição terreiro", cents: 10000 }
    ],
    variaveis: [
      { nome: "Claro multi", cents: 35000, min: 35000, max: 52500 },
      { nome: "Luz",         cents: 29524, min: 29524, max: 32014 }
    ],
    assinaturas: [
      { nome: "Agilize Basic",       cents: 25900, classe: "essencial" },
      { nome: "Wellhub",             cents: 23990, classe: "essencial" },
      { nome: "Bike ZiYou",          cents: 19990, classe: "luxo" },
      { nome: "Figma",               cents: 10537, classe: "essencial" },
      { nome: "iCloud / Apple One",  cents: 6690,  classe: "essencial" },
      { nome: "Plano saúde Lizzy",   cents: 5248,  classe: "essencial" },
      { nome: "Organizze",           cents: 3600,  classe: "essencial" },
      { nome: "Spotify",             cents: 2390,  classe: "essencial" },
      { nome: "Wow (anual)",         cents: 3332,  classe: "luxo", anual: true },
      { nome: "Serasa (anual)",      cents: 1816,  classe: "essencial", anual: true },
      { nome: "Stress Watch (anual)", cents: 833,  classe: "luxo", anual: true },
      { nome: "Petlove Club (anual)", cents: 290,  classe: "essencial", anual: true }
    ]
  },

  dividas: [
    { nome: "Fatura Inter ago/2026", saldoCents: 777212, parcelaCents: 0,     restam: null, juros: null,  estado: "acordo",   negativada: false, nota: "vai evoluir até cair no Serasa — acerto depois" },
    { nome: "Itaú maior",            saldoCents: 593059, parcelaCents: 0,     restam: null, juros: null,  estado: "acordo",   negativada: true },
    { nome: "Itapeva XI (Santander)", saldoCents: 480408, parcelaCents: 0,    restam: null, juros: null,  estado: "acordo",   negativada: true },
    { nome: "Itaú menor",            saldoCents: 238455, parcelaCents: 0,     restam: null, juros: null,  estado: "acordo",   negativada: true },
    { nome: "Nubank",                saldoCents: 612192, parcelaCents: 25508, restam: 24,   juros: false, estado: "correndo", negativada: false },
    { nome: "Linha de Crédito MP",   saldoCents: 219825, parcelaCents: 43965, restam: 5,    juros: true,  estado: "correndo", negativada: false },
    { nome: "DAS Simples Nacional",  saldoCents: 991815, parcelaCents: 30055, restam: 32,   juros: true,  estado: "correndo", negativada: false },
    { nome: "Dívida Ativa PGFN",     saldoCents: 725232, parcelaCents: 30218, restam: 24,   juros: true,  estado: "correndo", negativada: false },
    { nome: "Acordo Agilize",        saldoCents: 46980,  parcelaCents: 4698,  restam: 10,   juros: false, estado: "correndo", negativada: false },
    { nome: "João",                  saldoCents: 52500,  parcelaCents: 0,     restam: null, juros: null,  estado: "acordo",   negativada: false, nota: "sem prazo" }
  ],

  // Parcelas de cartão ainda rodando (find_installments, alta confiança)
  parcelas: [
    { desc: "Apple Watch",        cents: 10240, restam: 19 },
    { desc: "QuintoAndar",        cents: 67662, restam: 2 },
    { desc: "Alura",              cents: 19964, restam: 10 },
    { desc: "Prótese",            cents: 39125, restam: 2 },
    { desc: "Mercado Livre (7x)", cents: 30219, restam: 6 },
    { desc: "Lambuzada (roupas)", cents: 10063, restam: 2 },
    { desc: "Drogasil / Droga Raia", cents: 24538, restam: 1 },
    { desc: "PetLove Dog Hero",   cents: 990,   restam: 11 }
  ],

  ultimos: [
    { data: "2026-08-17", desc: "Rateio de corrida — Diogo", cents: -1520, cat: "Uber e 99" },
    { data: "2026-08-17", desc: "Pix — João Paulo",          cents: -720,  cat: "Outros" },
    { data: "2026-08-16", desc: "Full Time Body Club",       cents: -6000, cat: "Bares e bebidas" },
    { data: "2026-08-16", desc: "Pix — Priscila (rolê)",     cents: -5000, cat: "Lugares e rolês" },
    { data: "2026-08-16", desc: "Pix — Helen (rolê)",        cents: -3300, cat: "Lugares e rolês" },
    { data: "2026-08-16", desc: "Pix — Dex (rolê)",          cents: -2500, cat: "Lugares e rolês" },
    { data: "2026-08-16", desc: "Full Time Body Club",       cents: -1600, cat: "Bares e bebidas" },
    { data: "2026-08-15", desc: "Soul Jazz Hamburgueria",    cents: -5104, cat: "Restaurantes" },
    { data: "2026-08-15", desc: "Pix — Jackson (rolê)",      cents: -2700, cat: "Lugares e rolês" },
    { data: "2026-08-14", desc: "Guias do terreiro",         cents: -19000, cat: "Religião" },
    { data: "2026-08-13", desc: "Luz",                       cents: -32014, cat: "Energia" },
    { data: "2026-08-13", desc: "Super Varejão Caraça",      cents: -7631, cat: "Feira" }
  ],

  orcamentos: [
    { nome: "Gasto livre (dopamina)", tetoCents: 80000, usadoCents: 56124 }
  ]
};
