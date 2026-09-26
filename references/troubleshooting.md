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

## Túneis / publicar URL local (`scripts/expose-port/domain.py`)

| Erro | Causa | Correção |
|---|---|---|
| URL entregue sem `?token=` / URL local devolvida | publicado à mão, perdendo path/query | usar `domain.py up '<url completa>'` e entregar a linha `URL=` |
| `… já tem registo DNS que não é desta skill` | o nome pedido tem A/AAAA/CNAME de terceiros | outro `--name`, ou `--force` (substitui; CNAME é PATCHado sem janela NXDOMAIN) |
| `sem permissão para POST …/cfd_tunnel` / API 10000 ao criar túnel | sem `~/.cloudflared/cert.pem` e token sem `Cloudflare Tunnel:Edit` | `domain.py setup` (faz o `cloudflared tunnel login` sozinho) ou acrescentar a permissão ao token |
| `domain.py` sai com exit 4 | à espera do *Authorize* no browser | abrir a URL impressa (qualquer aparelho), escolher o domínio, *Authorize*; repetir |
| `cloudflared`/`node` em falta | máquina nova | `domain.py setup --deps` instala (binários oficiais, SHA256, sem sudo) — o `up` já o faz sozinho |
| `o túnel da zona … não ficou pronto` | egress 7844 bloqueado / túnel apagado fora da skill | `domain.py purge <zona>` e `up` de novo |
| 530 (Error 1033) logo após criar/trocar um CNAME | propagação da edge: host novo 8–33 s; troca de túnel 1–3 min | esperar (a verificação do `up` já espera); hosts cobertos pelo curinga não sofrem isto |
| Host novo ainda NXDOMAIN no browser do utilizador | cache negativa (SOA min 1800 s) de um resolver que perguntou antes de o registo existir | usar hosts cobertos por `*.zona` (sempre resolvem); `resolvectl flush-caches` localmente |
| 502 da edge com a app parada | a edge troca o 502 do router pela página dela | `domain.py up` diz `app-down`; subir a app |
| 403 nas rotas `/api` da app | fence de Host/Origin (só loopback) | publicar SEM `--keep-host` (reescrita ligada, é o padrão) |
| quick tunnel: `gate proxy did not become healthy on 127.0.0.1:3100` | outra coisa na porta 3100 (ex.: um proxy antigo deixado como serviço) | `ss -ltnp \| grep 3100`; parar o dono; ou usar o modo domínio |
| `expose-port-cloudflare-agent-skill: … cli.sh: Arquivo ou diretório inexistente` | atalho gerado antes da fusão aponta para o repo antigo | `bash scripts/expose-port/install.sh` (reescreve o atalho) |

## Registo global da skill (symlinks)

| Erro | Causa | Correção |
|---|---|---|
| Skill não aparece no agente | symlink em falta no root desse agente | `bash scripts/link-skill-global.sh` (idempotente) |
| `link divergente` movido para backup | existia outra coisa com o mesmo nome | inspecionar `~/.local/state/cloudflare-agent-skill/link-backups/<ts>/` |
| Frontmatter inválido | name/description em falta | corrigir SKILL.md (name ≤64, `^[a-z0-9-]+$`) |
