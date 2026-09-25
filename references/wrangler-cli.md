# Wrangler CLI — fluxo de trabalho, configuração e troubleshooting

Destilação de `wrangler` (Cloudflare, "Run or troubleshoot Wrangler CLI commands..."). A lista
exaustiva de comandos por produto está em `references/wrangler-cheatsheet.md` — este módulo
cobre o fluxo de trabalho (dev local, previews, deploy, rollback, tail), a configuração de
projeto e o troubleshooting do próprio Wrangler.

## Quando usar este módulo

- Correr ou diagnosticar comandos do Wrangler e configurar um projeto Worker.
- Escolher entre dev local, Previews, Version URLs e Wrangler environments.
- Depurar falhas de auth, config ou deploy do Wrangler (tabela de erros em `references/troubleshooting.md`).

## Procedimento

### 1. Inspecionar o projeto

- Identificar package manager, versão instalada do Wrangler, package scripts, framework e
  config do Wrangler. Correr comandos pelos scripts/packagemanager do projeto para usar a versão
  local. Instalar dependências com o lockfile existente; **não fazer upgrade silencioso do
  Wrangler** para bater com a documentação atual. Se o Wrangler não for dependência, seguires a
  installation guide: <https://developers.cloudflare.com/workers/wrangler/install-and-update/>.
- Identificar a config usada pelo build/deploy (incluindo config gerada por framework) e editar
  a fonte, nunca o output gerado.
- Estabelecer alvo antes de qualquer comando que altere estado: conta, Worker, environment,
  recurso. Para operações de dados, decidir se o alvo é local ou remoto.

### 2. Recuperar só o que a tarefa precisa

Usar a tool MCP `docs` da Cloudflare se disponível, ou ir buscar a página ligada. Seguir links
para o comando/produto específico; evitar carregar a referência inteira. Se uma página mudar,
redescobri-la pelo [command index](https://developers.cloudflare.com/workers/wrangler/commands/).
Comandos/flags mudam — nunca confiar em exemplos de memória; confirmar com o help local:

```bash
wrangler --help
wrangler <command> --help
```

| Tarefa | Fonte |
|---|---|
| Comandos e flags (recursos, deploys, rollback, diagnóstico) | `wrangler --help` / `wrangler <command> --help`; <https://developers.cloudflare.com/workers/wrangler/commands/> |
| Editar config / adicionar binding | `wrangler/config-schema.json` instalado (em `node_modules`); <https://developers.cloudflare.com/workers/wrangler/configuration/> |
| Deploy de uma framework app | <https://developers.cloudflare.com/workers/framework-guides/> (guia do framework + adapter do projeto) |
| Migrar para Workers | <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/> · <https://developers.cloudflare.com/workers/static-assets/migration-guides/vercel-to-workers/> |
| Staging vs produção | <https://developers.cloudflare.com/workers/wrangler/environments/> |
| Secrets (local, CI, Worker deployed) | <https://developers.cloudflare.com/workers/configuration/secrets/> |
| Gerar tipos de bindings/runtime | <https://developers.cloudflare.com/workers/languages/typescript/> |
| Dev local e testes | <https://developers.cloudflare.com/workers/local-development/> · <https://developers.cloudflare.com/workers/testing/> |
| Roles, scopes e permissões de API token | <https://developers.cloudflare.com/workers/authorization/> |
| Previews (branch/PR) | <https://developers.cloudflare.com/workers/previews/> · config em <https://developers.cloudflare.com/workers/previews/configuration/> |
| Auth e seleção de conta | `wrangler whoami`; <https://developers.cloudflare.com/workers/wrangler/commands/general/> · <https://developers.cloudflare.com/workers/wrangler/profiles/> |
| Prototype sem auth (claim) | <https://developers.cloudflare.com/workers/platform/claim-deployments/> (usar conta permanente em produção/CI) |

Se a documentação descrever uma feature inexistente na versão instalada, tornar explícita a
dependência de upgrade. Sem retrieval possível, declarar a lacuna e usar a evidência local —
nunca inventar sintaxe.

### 3. Aplicar a mudança

- Preferir `wrangler.jsonc` em config nova; `compatibility_date` = hoje em projetos novos e, ao
  avançar uma data existente, rever as runtime changes e testar. Preservar convenções do projeto.
- Verificar herança de environments antes de adicionar bindings/vars: alguns campos têm de ser
  declarados em cada environment — uma config default funcional NÃO prova que staging está configurado.
- Cloudflare Vite plugin: o environment seleciona-se via `CLOUDFLARE_ENV` no dev/build; faz-se
  deploy do build resultante — definir environment no deploy não retargeta a config flattened.
- Reconciliar mudanças do dashboard com a config antes de deploy: o Wrangler pode sobrescrever
  vars e routes do dashboard. Ao ligar recursos existentes, confirmar os identifiers — identifiers
  em falta podem despoletar automatic provisioning.
- Distinguir simulação local de remote bindings: um Worker em `wrangler dev` pode aceder a
  recursos reais; conferir os bindings selecionados antes de testar escritas.
- Antes de um comando remoto: identificar o member/token autenticado e o role/scope exigido pela
  operação exata; preferir o scope mais estreito. O OAuth de `wrangler login` não suporta
  autorização granular — usar account-owned API token quando for preciso; nunca pedir para colar
  o valor do token no chat.
- Secrets: fora de argumentos de comandos, código e logs (usar input interativo ou ficheiro/stdin
  protegido). Ficheiros locais de secrets têm de estar no `.gitignore` e NÃO são uploaded
  automaticamente como deployed secrets; sem secrets locais, verificar a precedência de ficheiros
  e a declaração `secrets.required`.
- `wrangler secret put` e `wrangler secret delete` são deploys: criam uma versão e fazem deploy
  imediato. Para staged, usar o workflow `wrangler versions secret`.
- Antes de rollback, ver as rollback limitations
  (<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>): recursos
  ligados e os seus dados NÃO são revertidos com o código do Worker.

### 4. Workers Previews

- Requerem Wrangler **local do projeto** 4.135.0 ou superior (comandos do projeto não usam um
  global mais novo); tornar explícito qualquer upgrade de dependência.
- Previews = environments de branch/PR sob o mesmo Worker; Version URLs = inspecionar uma versão
  específica com recursos de produção; Wrangler environments = Workers persistentes separados.
  Seguir <https://developers.cloudflare.com/workers/previews/compare-workflows/> em vez de adaptar
  workflows antigos de Version URL aliased.
- Configurar domínios de Preview pelo mesmo sistema de config da produção (Wrangler, dashboard ou
  Terraform) e fazer deploys de Preview pelo percurso existente (CLI local, Workers Builds, CI).
  Espelhar a abordagem de gestão — não os bindings/dados de produção.
- Antes de deploy, seguir a configuration placement table
  (<https://developers.cloudflare.com/workers/previews/configuration/#what-goes-in-the-previews-block>)
  e a resource matrix (<https://developers.cloudflare.com/workers/previews/resources/>): não inferir
  isolamento pelo nome do Preview nem permitir escritas em recursos de produção sem intenção explícita.
- URLs de Preview são públicas a menos que se configurem access controls — informar e deixar o
  utilizador decidir. Ao usar um Wrangler environment, passar o MESMO `--env` a todos os comandos
  de Preview; omitido, alveja o Worker de topo.

### 5. Validar

- Alterações de config/bindings em TypeScript: regenerar tipos com `wrangler types` (nunca editar
  declarações geradas à mão) e correr typecheck/testes existentes.
- Deploys: build workflow do projeto + `wrangler deploy --dry-run` com a config e o environment
  pretendidos. Um dry-run com sucesso valida build e packaging — NÃO prova recursos remotos nem
  comportamento em runtime.
- Previews: uma URL devolvida não valida comportamento que depende de bindings que o Wrangler
  reporta como missing; validar o comportamento pedido com logs/config próprios de Preview.
- Reportar: o que mudou, environment alvo, verificações feitas e lacunas de validação por resolver.

## Conhecimento essencial

- Os exemplos memorizados ficam obsoletos: flags e campos de config mudam. Baseline = versão e
  schema instalados no projeto; docs só para confirmar.
- Comandos/flags do Wrangler NÃO cobertos pelo cheatsheet: `wrangler --help`,
  `wrangler <command> --help`, `wrangler login` (OAuth, dev humano — não granular),
  `wrangler versions secret` (staged secret change), `--env <ambiente>` em qualquer comando de
  environment/Preview, `CLOUDFLARE_ENV` (Vite plugin, no dev/build).
- Fluxo típico de release: `wrangler dev` (local) → `wrangler deploy --dry-run --outdir dist`
  → `wrangler deploy` → `wrangler tail` / `wrangler tail --format json` para observar →
  `wrangler versions upload` (preview URL em CI) → `wrangler rollback [version_id]` se necessário
  (comandos exatos em `references/wrangler-cheatsheet.md`).
- `wrangler secret put`/`secret delete` = deploy imediato; `wrangler versions secret` = staged.
- Rollback não desfaz dados de recursos ligados (KV, D1, R2, Queues).
- Comandos remotos: token com escopo mínimo (`references/auth-and-tokens.md`) e secret values
  nunca em argumentos/`echo` nos logs.
- Validação de erro: tabela `Erro → Causa → Correção` em `references/troubleshooting.md`
  (auth `code: 10000`, 403 missing permission, `Worker size exceeded`, `Compatibility date
  invalid`, deploy 409, `Unknown binding`, `wrangler dev` não sobe).

## Referências rápidas

| Tema | Ficheiro de detalhe |
|---|---|
| Enciclopédia de comandos por produto (KV, D1, R2, Queues, Pages…) | `references/wrangler-cheatsheet.md` |
| Autenticação, tokens, permissões mínimas, CI | `references/auth-and-tokens.md` |
| Erros comuns do Wrangler/API (Erro → Causa → Correção) | `references/troubleshooting.md` |
| Campos de config, bindings, secrets, observability | `references/upstream/workers-best-practices/references/configuration.md` |
| Template de config de referência | `assets/wrangler-template.toml` |
