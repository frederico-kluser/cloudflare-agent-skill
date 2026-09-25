# Workers — melhores práticas para produção

Destilação de `workers-best-practices` (Cloudflare). O detalhe profundo vive nos ficheiros
upstream indicados em "Referências rápidas"; este módulo cobre o essencial e encaminha.

## Quando usar este módulo

- Escrever, rever ou configurar código de Cloudflare Workers para produção.
- Definir configuração (`wrangler.jsonc`, bindings, secrets, observability) de um Worker.
- Rever anti-padrões de memória, promises, estado global, segurança e serialização.
- Fora do âmbito: Durable Objects (`references/upstream/durable-objects/references/rules.md`),
  Workflows ("Rules of Workflows": <https://developers.cloudflare.com/workers/build/rules-of-workflows/>),
  comandos do Wrangler (`references/wrangler-cli.md`, `references/wrangler-cheatsheet.md`).

## Procedimento

1. **Preferir retrieval a pre-training**: o conhecimento sobre APIs, tipos e configuração dos
   Workers pode estar desatualizado. Usar como baseline as versões instaladas no projeto, os
   tipos gerados e as compatibility settings do Wrangler; ir à documentação verificar APIs,
   comportamento de runtime e limites.
2. Verificar que `compatibility_date` e `compatibility_flags` suportam a feature afetada.
3. Escrever/rever o código segundo os padrões de runtime e a tabela de anti-padrões abaixo.
4. **Validar** com as verificações existentes do projeto: type-check para alterações de bindings
   ou de contrato de handlers; testes de runtime para alterações de comportamento. Uma edição
   estreita não exige auditoria completa aos Workers. Preservar os checks obrigatórios do repo.
5. Sem evidência suficiente: consultar <https://developers.cloudflare.com/workers/best-practices/workers-best-practices/>
   ou o produto em <https://developers.cloudflare.com/directory/>. Usar o schema do Wrangler
   instalado para campos de config — um type package mais novo NÃO substitui o target
   configurado no projeto.

## Conhecimento essencial

### Configuração

- **`compatibility_date` atualizada**: hoje (`YYYY-MM-DD`) em Workers novos; em existentes,
  atualizar periodicamente revendo as compatibility changes e correndo testes relevantes.
  Data/flags que não suportam o comportamento necessário = defeito de compatibilidade.
- **`nodejs_compat`**: ativa módulos nativos Node.js (`node:crypto`, `node:buffer`, `node:stream`);
  muitas bibliotecas exigem-no. Sem o flag, erros de import crípticos em runtime.

  ```jsonc
  {
    "compatibility_flags": ["nodejs_compat"]
  }
  ```
- **Tipos gerados, nunca escritos à mão**: `wrangler types` gera o `Env` a partir da config;
  voltar a correr após adicionar ou renomear qualquer binding. Procurar o padrão
  `satisfies ExportedHandler<Env>`. Um `interface Env` manual diverge dos bindings reais.
- **Secrets**: nunca em config nem em código-fonte — `wrangler secret put` e acesso via `env`;
  config não-sensível vai em `vars`. Verificar `.env` no `.gitignore`.
- **`wrangler.jsonc` em vez de `wrangler.toml`**: features novas são JSON-only e o JSONC aceita
  comentários. Sinalizar `wrangler.toml` em projetos novos.
- **Consistência binding-código**: todo o `env.X` tem declaração correspondente na config; nomes
  são case-sensitive; em Durable Objects, `class_name` = nome da classe exportada. Um binding não
  usado, só por si, não é um finding.
- **Observability em produção**: `observability.enabled` e `observability.traces.enabled` a `true`
  — o setting de topo sozinho NÃO ativa traces. `head_sampling_rate` controla volume/custo;
  logging estruturado JSON (`console.log(JSON.stringify({...}))`), `console.error` para erros
  (severity error no dashboard). Verificar overrides por environment.

  ```jsonc
  {
    "observability": {
      "enabled": true,
      "logs": { "enabled": true, "head_sampling_rate": 1 },
      "traces": { "enabled": true, "head_sampling_rate": 0.01 }
    }
  }
  ```

### Padrões de runtime

- **Streaming de bodies**: limite de 128 MB de memória; `await response.text()` /
  `await request.arrayBuffer()` em payloads grandes rebenta o Worker. Passar `response.body`
  diretamente ou usar `TransformStream` (`return new Response(response.body, response);`).
  Buffering só em payloads pequenos e limitados (JSON de tamanho conhecido).
- **`ctx.waitUntil()`** para trabalho após a resposta (analytics, cache writes, webhooks) —
  limite de 30 segundos após a resposta. Não desestruturar `ctx` (perde o receiver →
  "Illegal invocation").
- **Bindings, não REST API**: KV, R2, D1, Queues, Workflows são referências in-process — sem
  network hop, sem autenticação, sem latência extra. Nunca `fetch("https://api.cloudflare.com/client/v4/...")`
  para algo que existe como binding.
- **Queues vs Workflows**: Queues desacoplam produtor de consumidor (fan-out, batching, jobs de
  um passo, at-least-once delivery); Workflows = execução durável multi-passo (o valor de cada
  step é persistido; só steps falhados repetem; pode correr por horas/dias/semanas). Juntos:
  a Queue faz buffer de entrada e o consumidor cria instâncias de Workflow.
- **Service bindings** para Worker→Worker: zero-cost, sem passar pela internet pública, RPC
  type-safe (`env.AUTH_SERVICE.verifyToken(token)`), em vez de `fetch("https://...")` público.
- **Hyperdrive** para bases de dados externas: pool regional (poupa 300-500 ms de TCP+TLS+auth
  por request); criar um `Client` novo por request com `env.HYPERDRIVE.connectionString`;
  requer `nodejs_compat`.
- **Sem estado mutável ao nível do módulo**: os isolates são reutilizados entre requests —
  `let`/`var` globais vazam dados e causam "Cannot perform I/O on behalf of a different request".
  Passar estado por argumentos.
- **Promises flutuantes**: todo o async é `await`ed, `return`ed ou passado a `ctx.waitUntil()`;
  caso contrário o resultado é descartado, erros engolidos e o runtime pode terminar o isolate.
- **Limites de plataforma**: 10 ms de CPU (Bundled) ou 30 s (Standard/Unbound); trabalho
  síncrono pesado (loops, parsing de JSON grande, crypto intensiva) atinge o CPU limit — partir
  em chunks, offload para Queues/Workflows ou WebAssembly. Confirmar limites atuais em
  <https://developers.cloudflare.com/workers/platform/limits/>.
- **Segurança**: `crypto.randomUUID()` / `crypto.getRandomValues()` (nunca `Math.random()`);
  comparação de secrets com `crypto.subtle.timingSafeEqual()` sobre hash de tamanho fixo
  (não fazer short-circuit por diferença de comprimento — vaza timing).
- **Erros**: try/catch com respostas JSON estruturadas + `console.error`, nunca
  `ctx.passThroughOnException()` como error handling geral (fail-open que esconde bugs).
- **Testes**: `@cloudflare/vitest-pool-workers` corre no runtime dos Workers com bindings reais.
  Gotcha: o pool auto-injeta `nodejs_compat`, por isso os testes passam mesmo sem o flag no
  `wrangler.jsonc` — confirmar sempre a config. Cobrir retornos nullable (ex.: KV `.get()` → `null`).
- **Zod**: Workers que usam Zod para validação em runtime precisam de Zod 4.5.0 ou posterior
  (versões antigas retêm muito mais heap por schema — verificar em OOMs).

### Anti-padrões a sinalizar

| Anti-padrão | Consequência · padrão preferido |
|---|---|
| `await response.text()` (ou buffering) em dados ilimitados | Esgota a memória do Worker; fazer stream (`references/upstream/workers-best-practices/references/runtime-patterns.md#stream-request-and-response-bodies`) |
| Secrets hardcoded em código ou config | Vaza credenciais via version control; usar Wrangler secrets |
| `Math.random()` para tokens/IDs sensíveis | Valores previsíveis; usar `crypto.randomUUID()` ou `crypto.getRandomValues()` |
| Trabalho async sem await/return/`ctx.waitUntil()` | Trabalho descartado, erros perdidos; ligar ao tempo de vida do request ou de background work |
| Estado mutável de request ao nível do módulo | Vaza dados entre requests; erros de I/O ownership; passar estado explicitamente |
| Cloudflare REST API para operações com binding disponível | Overhead de rede e autenticação; usar o binding |
| `ctx.passThroughOnException()` como error handling geral | Encobre falhas ao reencaminhar para o origin; error handling explícito e respostas estruturadas |
| `Env` escrito à mão que duplica bindings do Wrangler | Diverge da configuração; gerar tipos com `wrangler types` |
| Comparação direta de strings de secrets | Vaza diferenças de timing; padrão Web Crypto (`references/upstream/workers-best-practices/references/runtime-patterns.md#use-web-crypto-for-secure-token-generation`) |
| Desestruturar métodos de `ctx` (`const { waitUntil } = ctx`) | Perde o receiver; chamar `ctx.waitUntil(...)` |
| `any` em `Env` ou parâmetros de handler | Esconde erros de contrato de bindings/handlers; usar tipos gerados e da plataforma |
| `as unknown as T` para forçar match de tipo da plataforma | Esconde incompatibilidades; corrigir o contrato subjacente |
| `implements` em vez de estender a base class da plataforma | Não herda comportamento de runtime, `this.ctx`, `this.env`; usar `extends` na base class |
| `env.X` sem vínculo em método de platform class | Bindings estão em `this.env.X` (`references/upstream/workers-best-practices/references/platform-apis.md#binding-access--the-most-common-error`) |
| Uma única regra de serialização para Queues, Workflow steps, storage e WebSockets | Rejeita payloads válidos ou aceita não suportados; verificar a API e o encoding específicos (`references/upstream/workers-best-practices/references/platform-apis.md#serialization-boundaries`) |

## Referências rápidas

| Tema | Ficheiro de detalhe |
|---|---|
| Configuração, compatibility dates, tipos gerados, secrets, observability | `references/upstream/workers-best-practices/references/configuration.md` |
| Streaming, promises, estado, service bindings, Hyperdrive, segurança, testes | `references/upstream/workers-best-practices/references/runtime-patterns.md` |
| Assinaturas de handlers, platform classes, acesso a bindings, serialização | `references/upstream/workers-best-practices/references/platform-apis.md` |
| Regras de Durable Objects | `references/upstream/durable-objects/references/rules.md` |
| Comandos e config do Wrangler | `references/wrangler-cli.md`, `references/wrangler-cheatsheet.md` |
