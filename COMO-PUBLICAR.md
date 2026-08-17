# ✦ Como colocar o riquinho no ar

**Uma vez só. Depois ele vive sozinho — sem Claude, sem plano, sem nada.**
Tempo: ~10 minutos. Custo: R$ 0.

---

## Antes de começar, tenha em mãos

| O quê | Onde pegar |
|---|---|
| Token do Organizze | app.organizze.com.br/configuracoes/api-keys → **Gerar novo token** |
| Seu e-mail do Organizze | `michel@mikhaelangelo.com.br` |
| Uma senha sua | você inventa agora — é ela que abre o painel |

---

## Passo a passo

**1.** Crie uma conta grátis em `dash.cloudflare.com` (e-mail + senha, sem cartão de crédito).

**2.** No menu lateral, **Compute (Workers)** → **Create** → **Start with Hello World!** → **Deploy**.

**3.** Na tela do Worker, clique em **Edit code**. Apague TUDO que estiver no editor e cole o
conteúdo inteiro do arquivo **`painel-worker.js`**. Clique em **Deploy** (canto superior direito).

**4.** Volte pra página do Worker → aba **Settings** → **Variables and Secrets** → **Add**.
Crie estas quatro, uma por uma, todas do tipo **Secret**:

| Nome | Valor |
|---|---|
| `ORGANIZZE_EMAIL` | seu e-mail do Organizze |
| `ORGANIZZE_TOKEN` | o token que você gerou no passo 0 |
| `SENHA` | a senha que você inventou |
| `SEGREDO` | qualquer texto longo e bagunçado (40+ caracteres aleatórios) |

Depois de criar as quatro, clique em **Deploy** de novo pra elas valerem.

**5.** Abra a URL do Worker (algo como `riquinho.seu-usuario.workers.dev`).
Digite a senha. **A estrela está no ar.** ✦

> 💡 No passo 2, se der pra escolher o nome do Worker, chama de `riquinho` — a URL fica mais bonita.

---

## No celular

Abra a URL no Safari/Chrome → menu compartilhar → **Adicionar à Tela de Início**.
Vira ícone de app, com a estrela cigana e tudo.

---

## Manutenção

| Preciso de... | Faço assim |
|---|---|
| Dados frescos | botão **Atualizar** (o eclipse) no topo — lê o Organizze na hora |
| Nova versão do código | Edit code → colar o `painel-worker.js` novo → Deploy |
| Trocar a senha | Settings → Variables → editar `SENHA` → Deploy |
| Trocar o token do Organizze | Settings → Variables → editar `ORGANIZZE_TOKEN` → Deploy |

---

## Se algo der errado

| Sintoma | O que é |
|---|---|
| "Senha incorreta" | o secret `SENHA` não foi salvo — refaça o passo 4 e clique em Deploy |
| Erro 502 no Atualizar | token do Organizze errado ou expirado — gere outro |
| Saldos diferentes do app | crie o secret opcional `INICIO` com a data em que sua conta do Organizze começou (padrão `2024-01-01`) |
| Fontes com cara diferente | sem internet a serifa cai pra Georgia — é fallback, não defeito |

---

## ⚠️ Conferência obrigatória no primeiro acesso

Antes de confiar no painel, compare **três números** com o app do Organizze:

1. **Caixa hoje** (tela Hoje) × soma dos saldos das contas
2. **Fatura em aberto** (tela Fluxo) × o que você deve nos cartões
3. **Gasto do mês** (tela Onde vai) × relatório de categorias do mês

Bateram os três? Pode confiar. Não bateu algum? Me chama que eu ajusto —
número errado em painel é pior que número nenhum, porque passa confiança.
