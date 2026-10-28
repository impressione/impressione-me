# Worker

Um Worker só: serve o site estático, recebe o form de contato e consome a
fila (`fetch` + `queue` no mesmo entrypoint). Deploy único: `npm run deploy`.

```
wrangler.jsonc      config do Worker (raiz: o Wrangler e o Builds acham sozinhos)
workers/
  app/
    index.js             entrypoint (fetch + queue fino + scheduled)
    contact-producer.js  form -> fila
    contact-consumer.js  dedupe D1 -> workflow.create (+ e-mails ao time)
    contact-classifier.js  clef-flash (fail-closed)
    contact-history.js   histórico por email (LOWER(email))
    auto-reply.js        decisão de tom + geração com fallback de LLMs
    contact-replies.js   persistência em contact_replies
    resend.js            envio da resposta ao visitante (HTTP)
    contact-workflow.js  ContactWorkflow (classifica -> responde -> roteia)
    daily-summary.js     query + monta resumo diário
    migrations/          DDL do D1 (0001 contatos, 0002 respostas)
```

## Convenção

- Config `wrangler.jsonc` na raiz (1 Worker = 1 config). Se um segundo Worker
  aparecer (ex. cron isolado), cada um ganha pasta própria com seu
  `wrangler.jsonc` e o deploy passa a usar `-c`.
- Código compartilhado (schema da mensagem da fila, validação) vai para
  `workers/shared/` quando o segundo uso aparecer — não antes.
- Recursos compartilhados: fila auto-provisionada pelo Wrangler no primeiro
  deploy; D1 idem (`impressione-me-db`, DDL em `migrations/` aplicado em
  runtime pelo `ensureSchema` ou por `npm run db:migrate` manual); DNS segue
  Terraform.

## Deploy (Workers Builds)

Um único projeto conectado ao repo Git:

| Projeto | Root directory | Build command | Deploy command | Watch paths |
|---|---|---|---|---|
| `impressione-me` | `/` (raiz) | `npm run build` | `npx wrangler deploy` | `src/**`, `public/**`, `workers/**`, `wrangler.jsonc`, `astro.config.mjs`, `package.json` |

Preview por PR desativado (o bloco `previews`/`preview_urls` saiu do
`wrangler.jsonc`: o D1 e a fila de preview não são auto-provisionados e o
deploy do PR falhava). Deploy manual local: `npm run deploy`.

## Resposta automática

- `real_contact` → `contact-history.js` carrega o histórico agrupado por
  `LOWER(email)`; `auto-reply.js` decide o tom e gera o texto com
  llama-4-scout, caindo para qwen3.8-27b e glm-4.7-flash.
- `contact_replies` tem `UNIQUE(contact_id)`: 1 resposta por contato, mesmo em
  replay do workflow. Falha de geração/envio fica registrada (`status='failed'`)
  e o time recebe o contato para resposta manual.
- Envio ao visitante via Resend (`resend.js`, `RESEND_API_KEY` secret). O
  binding `send_email` segue só para o e-mail ao time.
- O resumo diário inclui os contatos reais com a resposta enviada e não é
  enviado quando a janela não tem nenhum contato.

## Testes locais

- `npm test` — unitários (`node:test`, sem dependências): `fetch`
  (validação/redirects/honeypot), `queue` (email/replyTo/descarte),
  classificação, histórico, decisão/geração da resposta, Resend e resumo.
- `npm run dev:worker` — sobe o Worker com assets + API em
  `http://localhost:8787` (bindings em modo `local`: fila e email simulados,
  nada sai de verdade). Para testar a resposta automática, crie `.dev.vars`
  com `RESEND_API_KEY=...`; sem a chave o envio falha de forma controlada.
  Ex.:
  `curl -X POST -F "email=a@b.com" -F "website=" localhost:8787/api/contact`
  → `303 /contato/obrigado`.
- `npm run dev` (Astro) serve só as páginas — `/api/contact` dá 404 nele
  porque a API mora no Worker, não no Astro.

## Evolução prevista do fluxo de contato

1. `fetch POST /api/contact`: valida o form e publica na fila (produtor).
2. `queue`: salva o contato no D1 e dispara 1 `ContactWorkflow`.
3. Workflow: histórico por email → clef-flash → resposta automática (real) ou
   resumo diário (demais) → e-mail ao time.
