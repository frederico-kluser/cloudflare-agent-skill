# Durable Objects — estado persistente e coordenação

Módulo destilado da skill oficial `durable-objects` (Build, debug, or review Cloudflare Durable Objects code for persistent state and coordination). Serve para construir, depurar e rever código de Durable Objects (DOs) para estado persistente e coordenação na edge. O detalhe profundo vive em `references/upstream/durable-objects/` — este módulo destila o essencial e encaminha.

> A API de DOs pode estar desatualizada no treino do modelo: **preferir retrieval à memória** em qualquer tarefa de DOs. Fontes: Docs <https://developers.cloudflare.com/durable-objects/>, API Reference <https://developers.cloudflare.com/durable-objects/api/>, Best Practices <https://developers.cloudflare.com/durable-objects/best-practices/>, Examples <https://developers.cloudflare.com/durable-objects/examples/>, Roles and permissions <https://developers.cloudflare.com/workers/authorization/durable-objects/>.

## Quando usar este módulo

- Criar novas classes de Durable Objects para coordenação com estado
- Implementar RPC methods, alarms ou handlers de WebSocket
- Rever código de DOs existente contra as melhores práticas
- Configurar `wrangler.jsonc`/`toml` para DO bindings e migrations
- Escrever testes com a integração Vitest da Cloudflare
- Desenhar estratégias de sharding e relações parent-child

## Procedimento

1. **Delimitar o objeto por átomo de coordenação** — um DO por chat room/jogo/utilizador, nunca um DO global.
2. **Configurar o wrangler** (binding + migration SQLite):

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "MY_DO", "class_name": "MyDurableObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyDurableObject"] }]
}
```

3. **Escrever a classe DO** — estender `DurableObject` de `cloudflare:workers`, inicializar schema no constructor com `blockConcurrencyWhile()`, expor RPC methods (não `fetch()`):

```typescript
import { DurableObject } from "cloudflare:workers";

export interface Env {
  MY_DO: DurableObjectNamespace<MyDurableObject>;
}

export class MyDurableObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data TEXT NOT NULL
        )
      `);
    });
  }

  async addItem(data: string): Promise<number> {
    const result = this.ctx.storage.sql.exec<{ id: number }>(
      "INSERT INTO items (data) VALUES (?) RETURNING id",
      data
    );
    return result.one().id;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.MY_DO.getByName("my-instance");
    const id = await stub.addItem("hello");
    return Response.json({ id });
  },
};
```

4. **Criar o stub** (roteamento determinístico):

```typescript
// Deterministic - preferred for most cases
const stub = env.MY_DO.getByName("room-123");

// From existing ID string
const id = env.MY_DO.idFromString(storedIdString);
const stub = env.MY_DO.get(id);

// New unique ID - store mapping externally
const id = env.MY_DO.newUniqueId();
const stub = env.MY_DO.get(id);
```

5. **Persistir primeiro, cache depois** — storage antes de estado em memória:

```typescript
// SQL (synchronous, recommended)
this.ctx.storage.sql.exec("INSERT INTO t (c) VALUES (?)", value);
const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM t").toArray();

// KV (async)
await this.ctx.storage.put("key", value);
const val = await this.ctx.storage.get<Type>("key");
```

6. **Alarms** (um por DO):

```typescript
// Schedule (replaces existing)
await this.ctx.storage.setAlarm(Date.now() + 60_000);

// Handler
async alarm(): Promise<void> {
  // Process scheduled work
  // Optionally reschedule: await this.ctx.storage.setAlarm(...)
}

// Cancel
await this.ctx.storage.deleteAlarm();
```

7. **Testar** — ler a referência de testing antes de configurar a suite ou escrever testes de DO.

## Conhecimento essencial

### Quando usar (e quando NÃO)

| Necessidade | Exemplo |
|------|---------|
| Coordenação | Chat rooms, multiplayer games, collaborative docs |
| Strong consistency | Inventory, booking systems, turn-based games |
| Storage por entidade | Multi-tenant SaaS, per-user data |
| Ligações persistentes | WebSockets, real-time notifications |
| Trabalho agendado por entidade | Subscription renewals, game timeouts |

NÃO usar para: stateless request handling (usar Workers simples); necessidades de maximum global distribution; high fan-out de pedidos independentes.

### Regras críticas

1. **Model around coordination atoms** — um DO por chat room/jogo/utilizador, não um DO global
2. **Usar `getByName()` para routing determinístico** — mesma entrada = mesma instância de DO
3. **Usar SQLite storage** — configurar `new_sqlite_classes` nas migrations
4. **Inicializar no constructor** — `blockConcurrencyWhile()` só para setup de schema
5. **Usar RPC methods** — não handler `fetch()` (compatibility date >= 2024-04-03)
6. **Persist first, cache second** — escrever no storage antes de atualizar estado em memória
7. **One alarm per DO** — `setAlarm()` substitui qualquer alarm existente

### Anti-padrões (NUNCA)

- Single global DO a tratar todos os pedidos (gargalo)
- Usar `blockConcurrencyWhile()` em cada pedido (mata o throughput)
- Guardar estado crítico só em memória (perdido em evicção/crash)
- Usar `await` entre storage writes relacionados (quebra a atomicidade)
- Manter `blockConcurrencyWhile()` durante `fetch()` ou I/O externo

### Gotchas clássicos

- **Evicção**: estado em memória tem de ser reconstruível — dados essenciais ficam em durable storage; estado só em memória perde-se em evicção/crash.
- **Storage gates e corridas de I/O externo**: rever gates de storage, corridas de I/O externo, transações e inicialização de schema — nunca intercalar I/O externo entre writes relacionados nem segurar `blockConcurrencyWhile()` sobre I/O externo (ver `references/upstream/durable-objects/references/rules.md`).
- **Migrations de classes**: mudanças de lifecycle passam por novas tags de migration (nunca reescrever as antigas); ver Class exports / legacy class migrations em `references/upstream/durable-objects/references/rules.md`.
- **WebSockets idle**: preferir hibernation e planear a restauração de estado após hibernação (restaurar connection state no wake).
- **Erros, restarts e shutdowns**: tratar exceções, reinícios e encerramentos — ver Error handling / Object lifecycle em `references/upstream/durable-objects/references/rules.md`.
- **Data location**: placement hints e jurisdiction constraints configuram-se em Data location (via `references/upstream/durable-objects/references/rules.md`).

### Autorização

Durable Objects não têm roles ou permissions próprias — o acesso segue o Worker que os implementa. Obter a guidance atual (<https://developers.cloudflare.com/workers/authorization/durable-objects/>) antes de conceder acesso a observability ou Data Studio, e delimitar a role do Worker ao Worker/produto pretendido.

### Integração com Workers (resumo)

- Config completa (`nodejs_compat`, bindings de DO, `migrations` com `new_sqlite_classes`, vars, KV, R2, D1) em `wrangler.jsonc` — ver `references/upstream/durable-objects/references/workers.md`.
- Exportar as classes DO do entrypoint do Worker (`export { ChatRoom } from "./durable-objects/chat-room";`) e tipar `Env` com `DurableObjectNamespace<Classe>`.
- Validar pedidos (ex.: zod) e responder 400 em inválido; envolver chamadas a DO em try/catch (erro do DO → 503); timeouts com `Promise.race`.
- Secrets via CLI: `wrangler secret put API_KEY` (nunca em ficheiros de config).
- Observability: logging estruturado + request tracing (`crypto.randomUUID()`); produção com Tail Workers (`"tail_consumers": [{ "service": "log-collector" }]`).
- Comandos: `wrangler dev`, `wrangler deploy`, `wrangler tail`.

### Padrões de teste (resumo)

Usar a integração Vitest da Cloudflare para exercitar DOs no runtime Workers. Antes de mudar uma suite existente, inspecionar packages Vitest/Cloudflare instalados, configuração e test scripts; adicionar um teste não exige migrar a suite.

- Testes RPC para comportamento do objeto; testes HTTP de integração para routing do Worker e contratos de resposta.
- Verificar que um objeto retém estado entre chamadas e que identidades diferentes ficam independentes. Inspecionar o estado SQLite quando a persistência é o contrato sob teste — chamadas repetidas não provam recuperação após restart.
- Para alarms, verificar os efeitos do trabalho agendado e qualquer reschedule/cancel, com o helper documentado (sem esperar wall-clock time).
- Confirmar o isolation model da integração instalada antes de reutilizar nomes de objetos; usar identidades separadas ou cleanup explícito onde o estado é partilhado.

Pesquisa útil: `blockConcurrencyWhile`, `idFromName`, `getByName`, `setAlarm`, `sql.exec`

## Referências rápidas

| Tema | Ficheiro |
|------|----------|
| Regras core: fronteiras de objetos, routing determinístico, parent-child, init; storage SQLite vs KV; storage gates, I/O races, transações, schema; migrations de classes; data location; stubs/RPC/HTTP; alarms; WebSockets/hibernation; error handling | `references/upstream/durable-objects/references/rules.md` |
| Testes: Vitest, migração de suites, configuração, test APIs, isolation/concurrency, exemplos de DOs | `references/upstream/durable-objects/references/testing.md` |
| Integração Workers: wrangler.jsonc/toml, TypeScript types, handler pattern, validação, logging/observability, error handling, timeouts, CORS, secrets, comandos de dev | `references/upstream/durable-objects/references/workers.md` |
