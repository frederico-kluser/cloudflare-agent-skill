# Email — Cloudflare Email Service (Email Sending e Email Routing)

Módulo de destilação de `cloudflare-email-service` (Email Sending + Email Routing + configuração de delivery). O detalhe profundo vive em `references/upstream/cloudflare-email-service/references/` — este módulo decide, resume e encaminha.

## Quando usar este módulo

- Implementar ou corrigir integrações de **Email Sending** (envio transacional) ou **Email Routing** (receção/encaminhamento de email).
- Configurar domínios, bindings `send_email`, routing rules (incl. catch-all) ou Email Workers.
- Melhorar deliverability (SPF/DKIM/DMARC), gerir suppressions/bounces ou monitorizar envios.
- Diagnosticar envios falhados, emails perdidos ou problemas de parsing de email recebido.

### Email Routing vs Email Sending — quando usar cada

| | Email Sending (outbound) | Email Routing (inbound) |
|---|---|---|
| Para quê | Enviar email transacional (signups, password resets, confirmações de pedido) | Receber email do domínio e processá-lo programaticamente |
| Mecanismo | Binding `send_email` (Workers), REST API, `wrangler email sending send`, MCP | Handler `email()` do Worker, ligado por routing rules |
| Guia | `references/upstream/cloudflare-email-service/references/sending.md` + `references/upstream/cloudflare-email-service/references/rest-api.md` | `references/upstream/cloudflare-email-service/references/routing.md` |

Regra de escolha: **binding para Workers** (sem API keys); **REST API** para apps externas (Node.js, Go, Python) ou quando pedido explicitamente; **MCP/wrangler CLI** para coding agents (Claude Code, Cursor, Copilot). Email Service é **apenas transacional** — newsletters/campanhas usam plataforma de marketing dedicada.

## Procedimento

### 0. Pré-requisitos (antes de escrever código de email)

1. **Domínio onboarded?** `npx wrangler email sending list` — se não estiver listado: `npx wrangler email sending enable userdomain.com` (ou Dashboard).
2. **Binding configurado?** procurar `send_email` no `wrangler.jsonc` (Workers): `"send_email": [{ "name": "EMAIL" }]`.
3. **postal-mime instalado?** `npm ls postal-mime` (só é necessário para receber/parsear emails).

### 1. Configuração de domínio, routing e Email Workers

Dashboard: **Compute & AI** > **Email Service** > **Email Sending** (ou **Email Routing**) > **Onboard Domain** > escolher domínio > **Add records and onboard**. Adiciona automaticamente SPF (TXT) e DKIM (CNAME/TXT); DNS propaga tipicamente em 5-15 minutos.

CLI (referência completa: `npx wrangler email --help`):

```
wrangler email routing
├── enable/disable   <domain>          # Toggle email routing
├── dns get          <domain>          # Show required DNS records
├── rules list/create/update/delete    # Manage routing rules
└── addresses list/create/delete       # Destination addresses (account-scoped)

wrangler email sending
├── enable/disable   <domain>          # Toggle email sending
├── dns get          <domain>          # Show sending DNS records (SPF, DKIM)
├── send             --from --to ...   # Send an email (builder flags)
└── send-raw         --from --to ...   # Send a raw MIME email
```

Routing rules (incl. **catch-all**): **Dashboard** > **Compute & AI** > **Email Service** > **Email Routing** > **Routing Rules**, ou `wrangler email routing rules create`. Destinos de forward têm de ser verificados primeiro: `wrangler email routing addresses create user@gmail.com` (account-scoped) ou Dashboard. Detalhe de regras/catch-all: `references/upstream/cloudflare/references/email-routing/`.

Email Worker — exportar um handler `email()` (não precisa de binding; a routing rule liga o endereço ao Worker):

```typescript
export default {
  async email(message, env, ctx): Promise<void> {
    console.log(`Email from ${message.from} to ${message.to}`);
    await message.forward("team@company.com");
  },
} satisfies ExportedHandler<Env>;
```

`message` é um `ForwardableEmailMessage` (tipos completos: `npx wrangler types`):

- `message.from` / `message.to` — envelope addresses (SMTP MAIL FROM / RCPT TO). `message.from` é fiável; headers podem ser spoofed.
- `message.headers` — objeto `Headers` (`.get("subject")`, `.get("message-id")`, etc.).
- `message.raw` — `ReadableStream<Uint8Array>` de MIME bruto. **Single-use** — fazer buffer primeiro.
- `message.rawSize`, `message.setReject(reason)` (erro SMTP permanente), `message.forward(rcptTo, headers?)`, `message.reply(emailMessage)`.

Operações: **forward** `await message.forward("team@company.com")` (com headers opcionais); **reject** `message.setReject("Your message was blocked")`; **reply** preferir `env.EMAIL.send({...})` (sem dependências) em vez de `message.reply()` + `mimetext` (requer `nodejs_compat`). Parsing: `postal-mime` sobre `const rawBuffer = await new Response(message.raw).arrayBuffer()`. Padrão store-and-reply-later (human-in-the-loop com Durable Object SQLite + reply via binding com headers `In-Reply-To`/`References`): ver `references/upstream/cloudflare-email-service/references/routing.md`.

### 2. Envio (Email Sending)

Workers binding (preferido em Workers):

```typescript
await env.EMAIL.send({
  to: original.sender,
  from: original.recipient,
  subject: `Re: ${original.subject}`,
  text: replyBody,
  html: `<p>${replyBody}</p>`,
  headers,
});
```

CLI:

```bash
npx wrangler email sending send \
  --from "agent@yourdomain.com" \
  --to "developer@company.com" \
  --subject "Deployment Complete" \
  --text "Your Worker was deployed successfully."
```

REST API (apps externas; o `from` usa `address`, não `email`):

```bash
curl "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/email/sending/send" \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --header "Content-Type: application/json" \
  --data '{
    "to": "developer@company.com",
    "from": {"address": "agent@yourdomain.com", "name": "Build Agent"},
    "subject": "Deployment Complete",
    "text": "Your Worker was deployed successfully."
  }'
```

Development local: adicionar `"remote": true` ao binding (`{ "send_email": [{ "name": "EMAIL", "remote": true }] }`) e correr `npx wrangler dev` — **os emails são enviados mesmo** (usar endereços de teste que controlas); remover `"remote": true` antes do deploy. MCP (`https://mcp.cloudflare.com/mcp`): ferramentas `search`/`execute` para endpoints `email/sending` (ex.: `GET /accounts/${accountId}/email/sending/limits`, `POST .../email/sending/send`).

Sempre incluir `html` **e** `text`. Antes de escrever código, ler o guia da tarefa em `sending.md` ou `rest-api.md`; correr `wrangler types` via package manager do projeto após mudar bindings. Nunca reutilizar um payload/parser de Workers binding na REST API sem verificar field names, attachments, response shape e erros.

### 3. Deliverability (SPF/DKIM/DMARC)

Com o onboarding do domínio, a Cloudflare configura automaticamente: **SPF** (TXT), **DKIM** (assinatura), **IP reputation**, **soft bounce retries** (exponential backoff), **suppression lists** e **feedback loops**. Adicionar **DMARC** se não existir: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@yourdomain.com`.

- **Hard bounces** (permanentes) nunca são reenviados; o endereço vai para suppression list; enviar para endereço suprimido retorna `E_RECIPIENT_SUPPRESSED`.
- **Soft bounces** (temporários: mailbox cheia, servidor em baixo, greylisting) são repetidos automaticamente.
- Responsabilidades do remetente: HTML + plain text, nome de remetente reconhecível (`{ email: "noreply@app.com", name: "My App" }`), subjects honestos (sem ALL CAPS), `List-Unsubscribe` em emails recorrentes, URLs completas do próprio domínio (sem shorteners), validação de endereços, double opt-in, honrar unsubscribe.

Monitorização: resposta de cada envio (`result.delivered`, `result.permanent_bounces`, `result.queued`) → logar para métricas próprias; quota diária `GET /accounts/{account_id}/email/sending/limits`; suppressions `GET/POST/DELETE .../email/sending/suppression` (também zone-level em `/zones/{zone_id}/email/sending/suppression`); analytics GraphQL zone-level (`viewer > zones`) com datasets `emailSendingAdaptiveGroups` e `emailSendingAdaptive` (retenção 31 dias; requere permissão **Analytics Read**). Targets: delivery rate > 95%, hard bounce rate < 2%, complaint rate < 0.1%.

### 4. Troubleshooting

| Sintoma | Causa / correção |
|---|---|
| Email desaparece no Worker | O handler tem de agir: consumir `raw`, fazer forward ou `setReject` — sem isso o email é dropped |
| `forward()` falha silenciosamente | Destino não verificado → `wrangler email routing addresses create user@gmail.com` |
| Leitura de `message.raw` devolve vazio | Stream single-use → buffer primeiro |
| Envio rejeitado / dominío inválido | `from` tem de usar domínio onboardado; verificar `wrangler email sending list` / `dns get` |
| `E_RECIPIENT_SUPPRESSED` | Endereço em suppression list (hard bounce/spam complaint) — gerir via API/Dashboard |
| REST: campos ignorados/erro | REST usa `address` (em `from`) e `reply_to` (snake_case); binding usa `email` e `replyTo` |
| Email em spam | Falta `text`, subject suspeito, URLs encurtadas, DMARC ausente → ver deliverability |
| Análise de falhas em massa | GraphQL `emailSendingAdaptive` (`errorCause`, `errorDetail`, `dkim`, `dmarc`, `spf`, `isSpam`) |

## Conhecimento essencial

- **Preferir retrieval a pre-training**: o produto lançou em 2025 e evolui depressa. Fontes de verdade: docs `https://developers.cloudflare.com/email-service/`, spec REST `https://developers.cloudflare.com/api/resources/email_sending`, `@cloudflare/workers-types`, [Email agent walkthrough](https://developers.cloudflare.com/agents/examples/email-agent/). Em caso de discrepância, confiar na fonte original.
- Anti-padrões (comum a todos): esquecer o binding `send_email` (Email Service usa binding, não API key); enviar de domínio não verificado; ler `message.raw` duas vezes; só HTML sem `text`; usar Email Service para marketing/bulk; forward para destinos não verificados; testar com endereços falsos (bounces destroem a sender reputation); hardcodar API tokens; ignorar o requisito do domínio no `from`; usar `email` no `from` da REST API; usar `replyTo` na REST API.
- Repostas (reply) precisam de SPF/DKIM corretos no domínio (auto-configurados no onboarding).
- No fluxo human-in-the-loop: nunca auto-enviar a partir do handler `email()` — guardar draft, deixar o humano rever, enviar depois via ação separada; extrair `Message-ID`/`In-Reply-To`/`References` no ingest; attachments em R2 com metadados em SQLite; trabalho pesado (AI drafting, notificações) via `ctx.waitUntil()`; nunca armazenar o raw stream, só campos estruturados.
- Adaptar código REST para binding (ou vice-versa) exige verificar: address fields, representação de attachments, response shape e erros — contra a documentação do binding e os tipos gerados.
- Antes de testar, confirmar se a config local simula delivery ou envia correio real.

## Referências rápidas

| Tema | Ficheiro |
|---|---|
| Envio via Workers binding, recipients, attachments, headers, limits, Agents SDK | `references/upstream/cloudflare-email-service/references/sending.md` |
| Envio via REST API (HTTP), request schema, responses, erros, retry | `references/upstream/cloudflare-email-service/references/rest-api.md` |
| Receção: handler `email()`, forward/reject/reply, parsing, human-in-the-loop | `references/upstream/cloudflare-email-service/references/routing.md` |
| Setup de domínio, wrangler CLI, development local, MCP | `references/upstream/cloudflare-email-service/references/cli-and-mcp.md` |
| SPF/DKIM/DMARC, bounces, suppressions, quotas, GraphQL analytics | `references/upstream/cloudflare-email-service/references/deliverability.md` |

Outros upstream úteis: `references/upstream/cloudflare/references/email-routing/` (regras, catch-all, addresses) e `references/upstream/cloudflare/references/email-workers/` (padrões de Email Workers).
