# Seleção de produtos Cloudflare

Roteiro de descoberta e escolha de produtos Cloudflare para apps, APIs, AI agents, storage, networking e security. Começa pelo objetivo do utilizador, recomenda os produtos certos e depois carrega as referências de implementação em `references/upstream/cloudflare/references/<produto>/` — começa sempre no `README.md` do produto e segue para `configuration.md`, `api.md`, `patterns.md` ou `gotchas.md` conforme a tarefa.

## Como escolher

**Método:**

- Começa pelo objetivo do utilizador, não pelo nome do produto. Sugere ativamente produtos que resolvam o problema mesmo quando o utilizador os não nomeou — quem pede uploads, background jobs ou document search pode não saber que precisa de R2, Queues, Workflows ou AI Search — e explica o papel de cada produto recomendado.
- Usa o índice abaixo como mapa necessidade → produto. Um produto pode aparecer em várias categorias e uma solução pode combinar produtos: recomenda uma combinação pequena e coerente e só acrescenta um produto quando ele cobre um requisito concreto. Respeita a stack existente e as escolhas explícitas do utilizador.
- Quando produtos semelhantes servem, explica o requisito decisivo: data shape, consistency, coordination, execution lifecycle ou quanta infraestrutura o utilizador quer gerir.
- Antes de prometer um encaixe, confirma disponibilidade, limits e pricing atuais — mudam com frequência. Lê a referência do produto antes de implementar.

**Decisões rápidas por área:**

| Área | Como decidir |
| --- | --- |
| Apps e websites | Workers + Workers Static Assets para qualquer projeto novo (static sites, SPAs, full-stack) — o Workers faz tudo o que o Pages faz. Pages só para manter deployments existentes; migrar Pages → Workers quando a tarefa o pedir. Scaffold com C3; APIs e webhooks também em Workers. |
| APIs | Workers para request handlers com acesso aos serviços Cloudflare; dentro de Workers prefere bindings em vez de REST API; API Shield para descobrir e proteger endpoints; Rules e Snippets para mudanças HTTP pequenas na edge. |
| AI agents | Workers AI (inferência), AI Search (RAG gerido), Vectorize + Workers AI (retrieval custom), AI Gateway (observar/limitar providers), Agents SDK (agentes stateful com tools e chat), Dynamic Workers ou Sandbox (executar código não confiável), Browser Run (automação de browser). |
| Storage | D1 (registos com SQL), Durable Objects + DO storage (coordenação e estado por entidade), KV (configuração read-heavy), R2 (objetos e ficheiros), Artifacts (file trees versionadas), Hyperdrive (BD PostgreSQL/MySQL existente), Pipelines + R2 Data Catalog + R2 SQL (data lake). |
| Networking | Tunnel (origem sem IP público), Workers VPC (serviços privados), Spectrum (TCP/UDP), Load Balancing (múltiplas origens), Argo Smart Routing e Smart Placement (latência), DNS e SSL/TLS (domínios e certificados). |
| Security | WAF (regras de aplicação), DDoS Protection, Bot Management, API Shield, Turnstile (formulários), Workers secrets e Secrets Store (credenciais), Access e Cloudflare One (aplicações internas). |

**Regras de composição:**

- Assíncrono: Queues para jobs e bursts, Workflows para orquestração multi-step durável (retry, wait, resume), Cron Triggers para schedules — combina Cron com Queues ou Workflows para o trabalho em si.
- Caching: prefere Workers Cache; Cache API ou KV caching só quando um requisito concreto não é coberto.
- Exemplos do roteiro: uma app de uploads pode usar Workers (API) + R2 (ficheiros) + D1 (metadata) + Queues (processamento); um assistente documental começa com Workers + AI Search e passa a Vectorize + Workers AI quando precisa de retrieval custom. Recomenda apenas as peças que o comportamento pedido exige.

## Índice de produtos

Caminhos relativos à raiz da skill; cada diretório tem `README.md` e, conforme o produto, `configuration.md`, `api.md`, `patterns.md` e `gotchas.md`.

### AI e agentes

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Workers AI | Inferência gerida de modelos (linguagem, embeddings, imagem, fala) a partir de Workers ou de um serviço externo | `references/upstream/cloudflare/references/workers-ai` |
| AI Gateway | Observar e controlar pedidos a providers de IA com caching, rate limiting, logging e routing | `references/upstream/cloudflare/references/ai-gateway` |
| AI Search | Indexação e pesquisa geridas de conteúdo, com geração opcional de respostas (pipeline RAG) | `references/upstream/cloudflare/references/ai-search` |
| Vectorize | Controlar embeddings, indexação vetorial e retrieval para pesquisa semântica, recomendações ou RAG | `references/upstream/cloudflare/references/vectorize` |
| Artifacts | Árvores de ficheiros versionadas atrás de interface tipo repositório (Workers, REST API, Git) — repos por agente/sessão, build outputs | `references/upstream/cloudflare/references/artifacts` |
| Browser Run | Screenshots, PDFs, extração de conteúdo renderizado e automação de browser (Puppeteer/Playwright/CDP) | `references/upstream/cloudflare/references/browser-rendering` |

### Armazenamento e dados

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| D1 | Base de dados relacional gerida com semântica SQLite para registos de aplicação consultáveis com SQL | `references/upstream/cloudflare/references/d1` |
| Workers KV | Key-value para configuração, preferências e caches read-heavy que toleram dados stale (eventual consistency) | `references/upstream/cloudflare/references/kv` |
| R2 | Object storage para uploads, media, backups e static assets, com acesso por Workers binding ou API S3-compatible | `references/upstream/cloudflare/references/r2` |
| Durable Objects Storage | Storage dentro de um Durable Object — APIs de storage, transações e recuperação para dados coordenados por entidade (SQLite nas classes novas) | `references/upstream/cloudflare/references/do-storage` |
| Hyperdrive | Ligar Workers a uma base de dados PostgreSQL ou MySQL existente com connection pooling e query caching | `references/upstream/cloudflare/references/hyperdrive` |
| Pipelines | Ingest streaming: receber eventos por HTTP/Workers/Logpush, transformar com SQL e escrever em R2 como tabelas Iceberg ou ficheiros Parquet/JSON | `references/upstream/cloudflare/references/pipelines` |
| R2 Data Catalog | Organizar tabelas Apache Iceberg sobre R2 para data lakes e query engines compatíveis | `references/upstream/cloudflare/references/r2-data-catalog` |
| R2 SQL | Motor de queries serverless e read-only (Apache DataFusion) sobre tabelas Iceberg do R2 Data Catalog | `references/upstream/cloudflare/references/r2-sql` |
| Cache Reserve | Armazenamento de cache persistente construído sobre R2 para reduzir fetches à origem | `references/upstream/cloudflare/references/cache-reserve` |

### Compute e developer platform

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Workers Static Assets | Servir static sites, SPAs, sites gerados e apps full-stack (assets + lógica server) — a escolha para projetos novos | `references/upstream/cloudflare/references/static-assets` |
| Bindings | Dar a um Worker acesso a recursos configurados através do seu environment (preferir bindings à REST API dentro de Workers) | `references/upstream/cloudflare/references/bindings` |
| C3 (create-cloudflare) | CLI oficial para fazer scaffold de projetos Workers/Pages a partir de templates, com TypeScript e deploy imediato | `references/upstream/cloudflare/references/c3` |
| Containers | Correr container images ou software Linux na plataforma Workers, controlados através de Durable Objects | `references/upstream/cloudflare/references/containers` |
| Cron Triggers | Arrancar jobs periódicos num Worker por schedule e inspecionar o histórico de execução | `references/upstream/cloudflare/references/cron-triggers` |
| Queues | Desacoplar produtores de consumidores assíncronos e fazer buffer de bursts de trabalho | `references/upstream/cloudflare/references/queues` |
| Workflows | Orquestração durável multi-step: jobs que fazem retry, esperam e retomam sem perder trabalho concluído | `references/upstream/cloudflare/references/workflows` |
| Flagship | Feature flags com targeting e rollouts percentuais, avaliadas via binding ou OpenFeature SDK, sem redeploy | `references/upstream/cloudflare/references/flagship` |
| Smart Placement | Colocação automática da execução do Worker mais perto dos backends que ele chama | `references/upstream/cloudflare/references/smart-placement` |
| Snippets | Lógica edge JavaScript leve na Ruleset Engine para alterar pedidos e respostas HTTP | `references/upstream/cloudflare/references/snippets` |
| Workers for Platforms | Plataforma multi-tenant para correr e gerir código de clientes com isolamento e controlos por cliente | `references/upstream/cloudflare/references/workers-for-platforms` |
| Pages | Manter um deployment Pages existente (build, Git integration, Direct Upload) — usar Workers para projetos novos | `references/upstream/cloudflare/references/pages` |
| Pages Functions | Comportamento server-side num projeto Pages existente, com rotas por filesystem | `references/upstream/cloudflare/references/pages-functions` |
| Miniflare | Simulação local programática dos Workers para harnesses de desenvolvimento e teste customizados | `references/upstream/cloudflare/references/miniflare` |
| workerd | Runtime V8 de JS/Wasm que potencia os Workers — app server, dev tool ou HTTP proxy (não é um sandbox hardened) | `references/upstream/cloudflare/references/workerd` |
| Workers Playground | Sandbox no browser para experimentar e partilhar Workers sem autenticação nem setup local | `references/upstream/cloudflare/references/workers-playground` |

### Networking e entrega

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Cloudflare Tunnel | Ligar serviços de origem à Cloudflare sem IP público routable (cloudflared) | `references/upstream/cloudflare/references/tunnel` |
| Workers VPC | Aceder a serviços em redes privadas a partir de um Worker via TCP Sockets API (`cloudflare:sockets`) | `references/upstream/cloudflare/references/workers-vpc` |
| Spectrum | Proxy reverso L4 para proteger e acelerar tráfego TCP/UDP não-HTTP (SSH, jogos, MQTT, SMTP, RDP) | `references/upstream/cloudflare/references/spectrum` |
| Network Interconnect | Conectividade de rede privada e dedicada à rede Cloudflare (Direct/Partner/Cloud; apenas Enterprise) | `references/upstream/cloudflare/references/network-interconnect` |
| Argo Smart Routing | Otimizar em tempo real os caminhos de tráfego até à origem na rede Cloudflare | `references/upstream/cloudflare/references/argo-smart-routing` |

### Segurança

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| WAF | Proteção managed, custom rules, rate limiting e investigação de tráfego bloqueado ao nível da aplicação | `references/upstream/cloudflare/references/waf` |
| DDoS Protection | Proteção autónoma e always-on contra ataques DDoS em L3/4 e L7, incluindo Adaptive DDoS | `references/upstream/cloudflare/references/ddos` |
| Bot Management | Deteção e controlo de tráfego automatizado por ML/heurísticas, bot scores, JS detections e fingerprints JA3/JA4 | `references/upstream/cloudflare/references/bot-management` |
| API Shield | Descoberta, proteção e monitorização de endpoints de API (JWT validation, schema validation) | `references/upstream/cloudflare/references/api-shield` |
| Secrets Store | Credenciais ao nível da conta, partilhadas entre Workers e integrações suportadas | `references/upstream/cloudflare/references/secrets-store` |

### Observabilidade e analytics

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Observability | Escolher o sinal de telemetria certo (Workers Logs, real-time logs, Traces) e encontrar o guia de implementação | `references/upstream/cloudflare/references/observability` |
| Tail Workers | Processar eventos de execução de Workers em código (logs e exceções custom) | `references/upstream/cloudflare/references/tail-workers` |
| Analytics Engine | Base de dados de time-series para analytics de alta cardinalidade escrita a partir de Workers e consultada por SQL API | `references/upstream/cloudflare/references/analytics-engine` |
| Web Analytics | Analytics web privacy-first com Core Web Vitals e métricas de tráfego sem cookies | `references/upstream/cloudflare/references/web-analytics` |
| GraphQL Analytics API | Consultar analytics de todos os produtos Cloudflare num único endpoint GraphQL | `references/upstream/cloudflare/references/graphql-api` |

### Media e realtime

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Cloudflare Images | Armazenar, redimensionar, transformar e entregar imagens (hosted images, transformações por URL, binding de otimização) | `references/upstream/cloudflare/references/images` |
| Stream | Upload, encoding, armazenamento e entrega de vídeo on-demand ou live broadcasting | `references/upstream/cloudflare/references/stream` |
| RealtimeKit | SDKs de aplicação para adicionar chamadas e reuniões de vídeo/áudio em tempo real (sobre o Realtime SFU) | `references/upstream/cloudflare/references/realtimekit` |
| Realtime SFU | Infraestrutura de media real-time com selective forwarding unit para apps de áudio/vídeo/data customizadas | `references/upstream/cloudflare/references/realtime-sfu` |
| TURN Service | Relay de ligações WebRTC através de redes restritivas (NAT/firewalls) na anycast network | `references/upstream/cloudflare/references/turn` |

### Email

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Email Routing | Encaminhar email recebido para mailboxes de destino segundo regras baseadas no endereço | `references/upstream/cloudflare/references/email-routing` |
| Email Workers | Processar email recebido em código com o handler `email()` (filtrar, parsear, responder, armazenar) | `references/upstream/cloudflare/references/email-workers` |

### IaC, API e integrações

| Produto | Para que serve | Diretório |
| --- | --- | --- |
| Cloudflare API | Integrar a REST API da Cloudflare — autenticação, SDK oficial, padrões e troubleshooting | `references/upstream/cloudflare/references/api` |
| Terraform Provider | Gerir recursos Cloudflare como código declarativo com Terraform | `references/upstream/cloudflare/references/terraform` |
| Pulumi Provider | Gerir recursos Cloudflare como código em linguagens de programação com Pulumi | `references/upstream/cloudflare/references/pulumi` |
| Zaraz | Carregar e gerir tags e scripts de terceiros server-side através da edge da Cloudflare | `references/upstream/cloudflare/references/zaraz` |

## Notas

- **Quando consultar `gotchas.md` e `patterns.md` de cada produto:** o `README.md` roteia a tarefa; `gotchas.md` antes de colocar qualquer coisa em produção (limits, armadilhas de configuração, erros conhecidos) e `patterns.md` ao compor comportamento (ex.: cache, multi-tenant, upload, recuperação). Exemplos do próprio roteiro: KV tem leituras eventually consistent (incluindo keys inexistente em cache); `message.raw` dos Email Workers é single-use; containers não têm filesystem persistente; `workerd` open-source não é um sandbox hardened.
- **Necessidades sem diretório local** (Workers Cache, Rules, Load Balancing, Waiting Room, DNS, SSL/TLS, Cloudflare for SaaS, Dynamic Workers, Data Localization, Privacy Pass, MoQ, Email Service, Workers Builds/Previews, Logpush, Agent Lee, Cloudflare One/Access): usa a documentação oficial em <https://developers.cloudflare.com/directory/> e segue os links da página do produto.
- **Skills relacionadas** (quando instaladas e nomeadas): `wrangler`, `workers-best-practices`, `durable-objects`, `agents-sdk`, `cloudflare-one`, `cloudflare-one-migrations`, `cloudflare-email-service`, `turnstile-spin`, `sandbox-next`/`sandbox-stable`/`sandbox-migrate-to-next`, `nextjs-on-cloudflare`, `web-perf`.
- **Princípios de trabalho:** inspeciona o projeto existente e as versões pinned antes de escolher API ou configuração; trata a documentação atual da Cloudflare como source of truth (usa `node_modules/wrangler/config-schema.json` quando representar a versão pinned); preserva a arquitetura do projeto e faz a menor mudança que satisfaz o pedido; valida em proporção à mudança.
- **Storage tradeoffs:** <https://developers.cloudflare.com/workers/platform/storage-options/>. Documentação: <https://developers.cloudflare.com/> · Changelog: <https://developers.cloudflare.com/changelog/>.
