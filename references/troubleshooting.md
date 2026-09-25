# Troubleshooting (referência nível 3)

Tabela `Erro → Causa → Correção`. Acrescente aqui erros novos que encontrar
(e registe em `LEARNINGS.md`).

## Autenticação e tokens

| Erro | Causa | Correção |
|---|---|---|
| wrangler `Authentication error [code: 10000]` | token inválido/expirado/revogado | `bash scripts/cloudflare-doctor.sh`; criar token novo |
| wrangler 403 / `missing permission` | escopo em falta no token | editar token: `Workers Scripts: Edit` (e `Cloudflare Pages: Edit` para pages) |
| API `code 10000` | Bearer errado ou token sem acesso ao recurso | conferir `CLOUDFLARE_API_TOKEN` e Account/Zone Resources |
| `wrangler login` não abre browser | ambiente headless | usar `CLOUDFLARE_API_TOKEN` via env |
| `whoami` mostra conta errada | múltiplas contas | definir `CLOUDFLARE_ACCOUNT_ID` |

## Zonas, DNS e domínios

| Erro | Causa | Correção |
|---|---|---|
| Zone Resources não mostra o domínio | zona nunca adicionada à conta | **Add site** no dashboard; depois aparece na lista |
| Zona `pending` > 24 h | nameservers não propagaram / grafia | `dig NS dominio @1.1.1.1`; conferir NS no registrar |
| Domínio não resolve após troca de NS | **DNSSEC ativo no registrar** | desativar DNSSEC/DS no registrar (ex. GoDaddy) ANTES de trocar NS; esperar DS sumir (`dig DS dominio`) |
| API `code 81044` (zona inativa) | ativação incompleta | concluir nameservers; só depois operar |
| E-mail do domínio parou | MX não migraram | recriar registos MX na zona Cloudflare |
| `code 9106` | feature só em plano pago | verificar limites do plano Free |
| `wrangler pages deploy` falha com domínio | projeto sem domínio verificado | Pages → Custom domains → Set up a domain → Verify |

## Workers e deploys

| Erro | Causa | Correção |
|---|---|---|
| `Worker size exceeded` | bundle > 3 MB gzip | `wrangler deploy --dry-run --outdir dist`; dividir deps/import dinâmico |
| `Compatibility date invalid` | data futura/errada | usar data real (ex. `2026-09-24`) |
| Deploy 409 / conflito | deploy concorrente | repetir; ou `wrangler versions list` para ver estado |
| `Unknown binding` em runtime | binding não está no toml | adicionar binding + `wrangler types` |
| Cold starts altos | init pesado | lazy-init de SDKs; Smart Placement para subrequests latentes |
| `wrangler dev` não sobe | porta ocupada / workerd bloqueado | `--port 8788`; reinstalar `npm approve-scripts workerd` |

## API v4

| Erro | Causa | Correção |
|---|---|---|
| `code 7003` query inválida | parâmetro mal escrito | conferir `references/api-v4.md` |
| `code 1049` | id de zona/registo errado | `GET /zones?name=…` para resolver ids |
| `code 91098002` | corpo JSON com campos errados | validar payload contra `references/api-v4.md` |
| Resposta truncada | portão de 48 KB | paginar (`?page=N&per_page=50`) ou filtrar |
| 429 rate limit | rajadas de chamadas | backoff; agrupar operações via `wrangler` |

## Registo global da skill (symlinks)

| Erro | Causa | Correção |
|---|---|---|
| Skill não aparece no agente | symlink em falta no root desse agente | `bash scripts/link-skill-global.sh` (idempotente) |
| `link divergente` movido para backup | existia outra coisa com o mesmo nome | inspecionar `~/Agent-Skills/.link-backups/<ts>/` |
| Frontmatter inválido | name/description em falta | corrigir SKILL.md (name ≤64, `^[a-z0-9-]+$`) |
