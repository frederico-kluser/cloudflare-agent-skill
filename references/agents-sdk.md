# Cloudflare Agents SDK — aplicações com o pacote `agents`

Módulo destilado da skill oficial `agents-sdk` (Build, debug, or review Cloudflare Agents SDK applications using the agents package). Constroi, depura e revê aplicações do Agents SDK sobre Durable Objects. O detalhe vive em `references/upstream/agents-sdk/references/` — este módulo destila o núcleo e encaminha.

> O conhecimento do Agents SDK pode estar desatualizado: **preferir retrieval à memória** em qualquer tarefa do Agents SDK — <https://developers.cloudflare.com/agents/>.

## Quando usar este módulo

- Criar agents com estado persistente e sync automático para clientes
- Expor RPC chamável (`@callable`), scheduling, workflows duráveis, queue e retries
- Construir chat agents com streaming, email, webhooks/push, MCP, voice ou browser tools
- Rever ou depurar uma aplicação existente do `agents`

## Procedimento

1. **Verificar instalação**:

```bash
npm ls agents                                 # deve mostrar o pacote agents
npm install agents                            # se não instalado
npm install agents @cloudflare/ai-chat ai @ai-sdk/react   # para chat agents
```

2. **Configurar wrangler** — cada classe de agent precisa do seu DO binding + migration:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

3. **Definir a classe Agent** (base `Agent<Env, State>`):

```typescript
import { Agent, routeAgentRequest, callable } from "agents";

type State = { count: number };

export class Counter extends Agent<Env, State> {
  initialState = { count: 0 };

  validateStateChange(nextState: State, source: Connection | "server") {
    if (nextState.count < 0) throw new Error("Count cannot be negative");
  }

  onStateUpdate(state: State, source: Connection | "server") {
    console.log("State updated:", state);
  }

  @callable()
  increment() {
    this.setState({ count: this.state.count + 1 });
    return this.state.count;
  }
}

export default {
  fetch: (req, env) => routeAgentRequest(req, env) ?? new Response("Not found", { status: 404 })
};
```

4. **Roteamento** — os pedidos vão para `/agents/{agent-name}/{instance-name}`:

| Classe | URL |
|-------|-----|
| `Counter` | `/agents/counter/user-123` |
| `ChatRoom` | `/agents/chat-room/lobby` |

Cliente: `useAgent({ agent: "Counter", name: "user-123" })`. Roteamento custom: `getAgentByName(env.MyAgent, "instance-id")` e depois `agent.fetch(request)`.

5. **APIs core**:

| Tarefa | API |
|------|-----|
| Ler estado | `this.state.count` |
| Escrever estado | `this.setState({ count: 1 })` |
| Query SQL | `` this.sql`SELECT * FROM users WHERE id = ${id}` `` |
| Schedule (delay) | `await this.schedule(60, "task", payload)` |
| Schedule (cron) | `await this.schedule("0 * * * *", "task", payload)` |
| Schedule (intervalo) | `await this.scheduleEvery(30, "poll")` |
| Método RPC | `@callable() myMethod() { ... }` |
| RPC streaming | `@callable({ streaming: true }) stream(res) { ... }` |
| Iniciar workflow | `await this.runWorkflow("ProcessingWorkflow", params)` |
| Fiber durável | `await this.runFiber("name", async (ctx) => { ... })` |
| Enfileirar trabalho | `this.queue("handler", payload)` |
| Retry com backoff | `await this.retry(fn, { maxAttempts: 5 })` |
| Broadcast a clientes | `this.broadcast(message)` |
| Obter ligações | `this.getConnections(tag?)` |

## Conhecimento essencial

### Arquitetura (o que cada primitiva resolve)

- **Agent base class** — `Agent<Env, State>` assenta em Durable Objects: cada agent class é uma classe DO com binding próprio e entrada em `new_sqlite_classes`. Ciclo de vida: `onStart(props)`, hooks de ligação/hibernation (ver `references/upstream/agents-sdk/references/state-scheduling.md` e `routing.md`).
- **Estado** — persistente em SQLite, sincronizado automaticamente para clientes via `setState`. Usar estado sincronizado para dados que os clientes precisam de imediato; SQL para coleções maiores, histórico ou queries. Rejeitar updates inválidos em `validateStateChange`; `onStateUpdate` reage a updates aceites (não para validação).
- **Scheduling** — um delay ou data para trabalho que corre uma vez, cron para recorrência de calendário, intervalo para cadência fixa. Retries mantêm o Durable Object ativo.
- **Workflows** — `AgentWorkflow` para tarefas multi-step duráveis com retries independentes ou espera por aprovação externa. Manter side effects externos dentro de durable steps, operações retomadas idempotentes, e persistir via step results os valores necessários após recuperação. Relatórios de progresso e broadcasts a clientes podem repetir-se em retry — usar os durable step helpers documentados para mudanças de estado e completion reporting.
- **Durable execution** — `runFiber("name", fn)` + `ctx.stash` sobrevivem à evicção do DO (progresso checkpointado em SQLite); `onFiberRecovered(ctx)` decide o que fazer na recuperação. Cuidados: `stash` substitui o checkpoint inteiro (não é merge); a lambda NÃO é restaurada — só os dados do stash; não há auto-retry no throw; para pipelines longos com retries automáticos, usar Workflows; filtrar fibers concorrentes por `ctx.name` em `onFiberRecovered`. Helpers: `keepAlive()` / `keepAliveWhile(fn)`.
- **Client SDK** — `useAgent` (React state/RPC), `AgentClient` (outros clientes WebSocket), `agentFetch` (HTTP one-off), `useAgentChat` (UI de chat).

### Gotchas de configuração (NUNCA / sempre)

- NÃO ativar `experimentalDecorators` no tsconfig — parte o `@callable`
- Nunca editar migrations antigas — adicionar sempre uma tag nova (ex. `v2`)
- Cada classe de agent precisa do seu DO binding + entrada de migration
- `nodejs_compat` é obrigatório; adicionar `"ai": { "binding": "AI" }` para Workers AI (localmente `"ai": { "binding": "AI", "remote": true }`)
- Secrets via `wrangler secret put`, nunca hardcoded
- Nome de classe `MyAgent` vira kebab `my-agent` nas URLs — tem de coincidir exatamente; erro "Namespace not found" = `class_name` no wrangler não corresponde à classe exportada
- `npx wrangler types` gera `env.d.ts` — regenerar após mudar `wrangler.jsonc`; tsconfig deve estender `agents/tsconfig`
- Com `sendIdentityOnConnect: false`, a promise `ready` no cliente pode nunca resolver — usar state sync
- Vite: `[react(), cloudflare(), agents()]` (plugin `agents/vite`)

### Execução em background — escolhas

- **Queue** — FIFO sequencial built-in (`this.queue()`); retries bloqueiam items seguintes da queue (usar scheduling para esperas longas de recuperação); items removidos quando o orçamento de retries se esgota — **sem dead-letter queue**, registar falhas explicitamente; predicado de retry seletivo só em `this.retry()`, não em opções serializadas de queue/schedule.
- **Human-in-the-loop** — escolher a camada conforme onde a execução deve pausar: `needsApproval` para execução de tools de chat; workflow approval + elicitation para tarefas de fundo duráveis ou input MCP. Distinguir approval responses de client tool outputs; tratar timeouts de aprovação antes de executar a ação gated.

### Integrações e experimentais (núcleo)

- **MCP** — para servers novos, preferir `createMcpHandler` sobre o `McpAgent` depreciado; para servers existentes, verificar versão instalada antes de migrar (MCP SDK v2).
- **Email** — receção/resposta via Cloudflare Email Routing; resolvers: `createAddressBasedEmailResolver("EmailAgent")` (endereço → instância, suporta `+suffix`), `createSecureReplyEmailResolver(env.EMAIL_SECRET, { maxAge, onInvalidSignature })` (HMAC-SHA256), `createCatchAllEmailResolver("EmailAgent", "default")`; combinar resolvers por fallback; `isAutoReplyEmail(email.headers)` para ignorar auto-replies; config `send_email` no wrangler.
- **Webhooks** — rotear para `onRequest` via `getAgentByName`; responder rápido (200/202), verificar assinaturas, deduplicar por event IDs guardados, processar com `queue()`.
- **Push notifications** — Web Push + VAPID (`npx web-push generate-vapid-keys`, secrets), subscriptions em agent state, envio com `web-push`; remover subscriptions expiradas (404/410).
- **Server-driven messages** — `saveMessages` persiste mensagens e pede resposta do modelo; `persistMessages` atualiza contexto sem iniciar turn; `onChatResponse` reage a turns independentemente do trigger; antes de ler histórico ou chamar `saveMessages` fora de chat, fazer `await waitUntilStable` e tratar timeout sem continuar; preferir a forma funcional de `saveMessages` quando chamadas podem enfileirar-se.
- **Streaming chat** — `AIChatAgent` para conversas persistidas com streaming e tools; RPC streaming para output não-chat. Forward do abort signal do request para o model call (cancelamento para a geração). Client reconnection e evicção do DO são casos de recuperação distintos.
- **Observability** — eventos estruturados via `diagnostics_channel` com `subscribe` de `agents/observability`; canais: `agents:state`, `agents:rpc`, `agents:message`, `agents:schedule`, `agents:lifecycle`, `agents:workflow`, `agents:mcp`, `agents:email`; override por agent com `observability = undefined`; produção via Tail Workers (`diagnosticsChannelEvents`).
- **Experimental** — `@cloudflare/think` (chat agent de alto nível: `getModel()`/`getSystemPrompt()`, hooks `configureSession`/`beforeTurn`/`onChunk`/`onChatResponse`/`onChatError`, `subAgent()`; requer compatibility flag `experimental`); `@cloudflare/voice` (`withVoice(Agent)`, `onTurn(transcript, ctx)`, `context.speak(chunk)`, `useVoiceAgent`; providers Workers AI/Deepgram/ElevenLabs); Codemode (`@cloudflare/codemode`: o LLM escreve JS que orquestra tools em sandbox via `DynamicWorkerExecutor` + `createCodeTool`; binding `worker_loaders`; `globalOutbound: null` isola a rede; só JavaScript; `needsApproval` executa sem pausa); browser tools (`agents/browser`, CDP: `browser_search`/`browser_execute`; bindings `browser` + `worker_loaders`; usar `fetch()` quando não é preciso browser real).

## Referências rápidas

| Tema | Ficheiro (caminho relativo à raiz da skill) |
|------|----------|
| Estado persistente, validação, SQL e scheduling (delay/date/cron/interval) | `references/upstream/agents-sdk/references/state-scheduling.md` |
| Métodos RPC `@callable()`, streaming, timeouts, introspecção | `references/upstream/agents-sdk/references/callable.md` |
| Padrões de URL, `routeAgentRequest`, `getAgentByName`, opções (`props`, `onBeforeConnect`) | `references/upstream/agents-sdk/references/routing.md` |
| Config wrangler.jsonc, bindings, Vite, type generation, tsconfig | `references/upstream/agents-sdk/references/configuration.md` |
| Streaming de chat com `AIChatAgent`, streams retomáveis, tools, persistência | `references/upstream/agents-sdk/references/streaming-chat.md` |
| Cliente React/vanilla: `useAgent`, `useAgentChat`, `AgentClient`, `agentFetch` | `references/upstream/agents-sdk/references/client-sdk.md` |
| Turns autónomos do servidor: `saveMessages`, `persistMessages`, `waitUntilStable` | `references/upstream/agents-sdk/references/server-driven-messages.md` |
| Aprovações: `needsApproval`, workflow approval, elicitation, timeouts | `references/upstream/agents-sdk/references/human-in-the-loop.md` |
| Workflows duráveis `AgentWorkflow`, steps, lifecycle callbacks, state sync | `references/upstream/agents-sdk/references/workflows.md` |
| `runFiber`, `stash`, `onFiberRecovered`, sobreviver à evicção do DO | `references/upstream/agents-sdk/references/durable-execution.md` |
| Queue FIFO built-in, `this.retry()`, backoff/jitter, sem DLQ | `references/upstream/agents-sdk/references/queue-retries.md` |
| MCP client e server (`createMcpHandler`), transports, securing, migração SDK v2 | `references/upstream/agents-sdk/references/mcp.md` |
| Email Routing, resolvers (address-based, secure reply, catch-all), `onEmail`, `replyToEmail` | `references/upstream/agents-sdk/references/email.md` |
| Webhooks recebidos em `onRequest` e push notifications Web Push/VAPID | `references/upstream/agents-sdk/references/webhooks-push.md` |
| Eventos `diagnostics_channel`, canais, Tail Workers | `references/upstream/agents-sdk/references/observability.md` |
| `@cloudflare/think` (experimental): chat agent de alto nível, hooks, sub-agents | `references/upstream/agents-sdk/references/think.md` |
| `@cloudflare/voice` (experimental): STT/TTS em tempo real via WebSocket | `references/upstream/agents-sdk/references/voice.md` |
| Code Mode (experimental): LLM escreve/executa JS que orquestra tools em sandbox | `references/upstream/agents-sdk/references/codemode.md` |
| Browser tools (experimental) por CDP: `browser_search`, `browser_execute` | `references/upstream/agents-sdk/references/browse-the-web.md` |
