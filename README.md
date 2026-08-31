# ✦ riquinho

> O Organizze guarda o que aconteceu. O riquinho lê o céu do seu mês — e avisa antes, com leveza.

Painel financeiro pessoal do Michel. Lê o Organizze direto pela API, roda sozinho num
Cloudflare Worker (sem depender de Claude, plano ou conector) e fala na voz do Riquinho:
zero bronca, número primeiro, categoria intocável nunca vira alerta.

**Identidade:** carta celeste — pergaminho, tinta índigo e fio de ouro. O símbolo é a
**estrela cigana de oito pontas**, em homenagem à guia de frente do Michel.

## Arquitetura

```
Navegador (PC/celular)
   ↓  senha → cookie HMAC
Cloudflare Worker ······ guarda ORGANIZZE_EMAIL / ORGANIZZE_TOKEN / SENHA / SEGREDO como Secrets
   ↓  Basic auth + User-Agent
api.organizze.com.br/rest/v2
```

- A API do Organizze **bloqueia navegador** (403 sem CORS) — por isso o Worker existe.
- Núcleo de cálculo em três camadas: `DADOS → recalcular() → CALC → as telas só desenham`.
  Nenhuma seção calcula; todo número derivado nasce em `recalcular()`, com a regra em comentário.
- Cache do payload cru em `localStorage`; cache servido nunca é silencioso (o selo do topo avisa).

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | O app inteiro (HTML + CSS + JS, uma página) |
| `worker-src.js` | O servidor: auth, proxy do Organizze, `/api/bootstrap` |
| `dados-demo.js` | Retrato real de 17/08/2026 pra rodar offline |
| `build.mjs` | Gera `painel-worker.js` (worker com o HTML embutido) e `painel-preview.html` (demo offline) |
| `painel-worker.js` | **O artefato de deploy** — cola no editor do Cloudflare |
| `riquinho-identidade.html` | A identidade visual v3 (carta celeste) |
| `COMO-PUBLICAR.md` | Passo a passo de publicação |

## Publicar / atualizar

Primeira vez: siga o `COMO-PUBLICAR.md` (≈10 min, R$ 0).

Pra atualizar depois de mexer no código:

```bash
node build.mjs          # regenera painel-worker.js
```

e cole o `painel-worker.js` novo em **Edit code → Deploy** no dashboard do Cloudflare.

## Regras que o código carrega (não quebrar)

- ⛔ Sem vermelho de alarme: "melhor não" é vinho. Susto não ensina ninguém a gastar melhor.
- ⛔ `INTOCAVEIS` (Religião, Saúde, chá, Prevenção e saúde) nunca viram alvo de insight.
- ⛔ Fatura/dívida `congelada` não entra nos compromissos do mês.
- ⛔ O check da tela "A pagar" é local — nunca escreve `paid` no Organizze.
- Os sinais são fases da lua: cheia (pode) · minguante (vai com calma) · nova (melhor não).
- Todo número em fonte tabular (IBM Plex Mono); a serifa (Cormorant Garamond) é só título e voz.
- ⛔ O horizonte de `projetar()` é de **92 dias**. Já foi 31 e isso escondia o fundo do poço:
  o painel anunciava o menor saldo em 14/09 porque o DAS + PGFN de 30/09 caíam fora da janela.
  Não encurtar sem conferir onde cai o eclipse.

---

*"a estrada é longa, mas tem estrela em cima." — riquinho*
