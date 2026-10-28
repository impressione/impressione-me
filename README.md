# impressione.me

Site institucional da Impressione (`https://impressione.me`): Astro estático
servido por um Cloudflare Worker, com formulário de contato que salva em D1,
classifica com AI (clef-flash), responde automaticamente os contatos reais e
notifica o time — resumo diário do resto.

```
Browser --POST /api/contact--> Worker (fetch) --> Fila --> Workflow
                                                          |  histórico por email (D1)
                                                          |  clef-flash (classifica)
                                                          |  LLM -> Resend -> visitante
                                                          +-> e-mail ao time (send_email)
                                  |
                                  +---- assets ./dist (site)
Cron 12:00 UTC --> Worker (scheduled) --> resumo diário (só se houver contato) --> E-mail
```

## Pré-requisitos

- Node.js 22+ e npm
- Conta Cloudflare com acesso ao Worker `impressione-me` (só para deploy)

## Começando

```sh
npm ci
npm run dev          # site em http://localhost:4321 (só páginas; /api/contact dá 404 aqui)
npm run dev:worker   # site + API em http://localhost:8787 (fluxo completo, tudo simulado)
npm test             # testes unitários (node:test, sem dependências)
npm run build        # build estático -> ./dist
```

O `dev:worker` usa bindings em modo `local` (fila e e-mail simulados — nada
sai de verdade). Exemplo:

```sh
curl -X POST -F "email=a@b.com" -F "website=" localhost:8787/api/contact
# -> 303 /contato/obrigado
```

## Estrutura

```
src/pages/           Páginas Astro (index, contato, contato/obrigado, contato/falha)
public/              Arquivos estáticos (+ .assetsignore do Worker)
workers/app/         Worker único: index.js (fetch + queue fino + scheduled),
                     contact-producer.js (form -> fila),
                     contact-consumer.js (dedupe -> workflow + e-mails ao time),
                     contact-classifier.js (clef-flash),
                     contact-history.js (histórico agrupado por email),
                     auto-reply.js (decisão de tom + LLM + template),
                     contact-replies.js (persistência das respostas),
                     resend.js (envio ao visitante),
                     contact-workflow.js (D1 -> classifica -> responde -> roteia),
                     daily-summary.js (resumo), migrations/, wrangler.jsonc
tests/               Testes unitários + fixtures do golden set
dist/                Build (gerado, gitignored)
```

## Fluxo de contato

1. Form em `/contato` faz `POST /api/contact` (`email` obrigatório, campo
   oculto `website` como honeypot).
2. Worker valida e publica na fila `impressione-me-contact` (auto-provisionada
   no primeiro deploy) → `303 /contato/obrigado` (falha → `/contato/falha`;
   honeypot finge sucesso sem enfileirar).
3. Consumer salva no D1 (`INSERT OR IGNORE`) e dispara 1 `ContactWorkflow`.
4. Workflow carrega o histórico do email (agrupado por `LOWER(email)`, apenas
   contatos anteriores) e classifica com clef-flash em 2 perguntas: `tipo`
   (`real_contact` | `phishing_scam` | `spam`, com preempção phishing > spam)
   e `idioma` (PT | EN | outro — conteúdo real em outro idioma vira
   `suspicious_language`). Erro ou confiança < 0.6 → `unclassified`.
5. `real_contact` → gera resposta com Workers AI (llama-4-scout, fallback
   qwen3.8-27b e glm-4.7-flash), envia ao visitante via Resend e notifica o
   time com o texto da resposta. Se a geração falhar, nada é enviado e o time
   recebe o contato marcado para resposta manual.
6. Demais classes → resumo diário (cron 12:00 UTC = 09h BRT) com contagens +
   top 20. O resumo também lista os contatos reais com a resposta automática
   enviada e **não é enviado quando não há nenhum contato na janela**.

## Resposta automática

- O email é a chave do histórico: `contacts` + índice em `LOWER(email)`.
  `contact_replies` guarda 1 linha por contato (`UNIQUE(contact_id)`), então
  retry/replay do workflow nunca responde duas vezes.
- O tom muda conforme o tempo desde a última interação real: primeiro contato,
  retomada em < 24h, alguns dias ou mais de uma semana. Sempre responde.
- Prompt trata a mensagem do visitante como dado (anti prompt-injection), sem
  preço/prazo/links, e a assinatura + aviso de resposta automática são
  adicionados fora da LLM.
- Envio ao visitante usa **Resend** (free tier). O binding `send_email` da
  Cloudflare continua só para o e-mail ao time (destinatário verificado).

## Deploy

Automático via **Workers Builds** (1 projeto `impressione-me` ligado ao repo):

| Root directory | Build command | Deploy command |
|---|---|---|
| `/` (raiz) | `npm run build` | `npx wrangler deploy` |

Preview por PR desativado (sem bloco `previews`/`preview_urls` no
`wrangler.jsonc`: o D1 e a fila de preview não são auto-provisionados e o
deploy do PR falhava). Manual: `npm run deploy`.
O schema do D1 é garantido em runtime pelo próprio Worker (`db.js`, a partir
do mesmo DDL versionado em `workers/app/migrations/`) — dispensa `migrate`
no deploy. `npm run db:migrate` continua disponível para uso manual.
Setup uma vez, fora do deploy:
1. Nada para o D1 de produção: o primeiro deploy auto-provisiona o banco
   `impressione-me-db` a partir do binding; o schema entra pelo `ensureSchema`
   no primeiro contato/cron (ou por `npm run db:migrate` manual).
2. Resend: verificar o domínio `impressione.me` (DKIM/SPF) e cadastrar o
   secret `wrangler secret put RESEND_API_KEY`. Local: `.dev.vars` (ignorado
   pelo git) com `RESEND_API_KEY=re_...`. Sem a chave, a resposta automática
   falha de forma controlada e o contato cai no resumo diário.
3. Custom Domains `impressione.me` + `www` no Worker (Terraform, repo infra).
4. Checar plano do clef-flash: 1 chamada em produção; `403`/erro `5035`
   significa que exige Workers Paid ($5/mês).

## Relação com o repo de infra

DNS, domínios, R2 e OCI continuam em Terraform no repo `infrastructure`.
O app (fila, Worker, bindings) saiu do Terraform e é 100% Wrangler aqui —
ver `workers/README.md`.
