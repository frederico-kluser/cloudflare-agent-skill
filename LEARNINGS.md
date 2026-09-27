> **MEMÓRIA APOSENTADA (2026-09-27):** o conteúdo deste ficheiro foi migrado para a memória CoALA local do repositório (`.agents/cloudflare-agent-skill-coala-memory-agent-skill/`). Fica só como **fonte histórica** — não escrever mais aqui. Aprendizado novo: `python3 .agents/cloudflare-agent-skill-coala-memory-agent-skill/scripts/coala.py add --type episodic --content "…"`.

# LEARNINGS — cloudflare-agent-skill

Registo de aprendizados (fonte: utilizador > docs oficial > medição/inferência). Data primeiro.
Sem dados pessoais: domínios, contas e máquinas aparecem como `example.com`, `<conta>`, "a app local".

## 2026-09-25 — criação da skill
- Skills oficiais Cloudflare instalam-se com `npx -y skills add cloudflare/skills --skill '*' --yes --global`
  → `~/.agents/skills/` (14 skills: cloudflare, wrangler, workers-best-practices, …).
  O instalador reporta `✗ PromptScript: does not support global skill installation` para um
  alvo não-suportado — inócuo, as skills ficam instaladas (exit 0).
- `Zone Resources` do token API só lista zonas já adicionadas à conta: domínio noutro
  registrar (GoDaddy) só aparece depois de "Add site" + troca de nameservers.
- Ordem correta de migração de domínio: **DNSSEC OFF no registrar primeiro**, depois NS.
- Registo global: um symlink por skill root de agente (Claude Code, opencode, codex, …), com
  backup das divergências — `scripts/link-skill-global.sh`.

## 2026-09-25 — fusão das skills Cloudflare nesta skill (v2.0.0)
- Fonte: pedido do utilizador ("quero ter uma só que saiba tudo e faça tudo"). Foram fundidas
  13 skills oficiais (`cloudflare`, `wrangler`, `workers-best-practices`, `durable-objects`,
  `agents-sdk`, `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations`,
  `turnstile-spin`, `sandbox-stable`, `sandbox-next`, `sandbox-migrate-to-next`,
  `nextjs-on-cloudflare`) + `expose-port-cloudflare-agent-skill`; as antigas saem dos
  catálogos (`~/.agents/skills`, `~/.claude/skills`, …) para não competirem.
- Arquitetura: `SKILL.md` = roteador enxuto + `references/*.md` = módulos destilados (PT-PT)
  + `references/upstream/<skill>/` = snapshot verbatim (sem SKILL.md) das skills oficiais
  (repo `cloudflare/skills`, plugin `cloudflare@cloudflare` v1.0.0) — carregamento progressivo.
- As skills oficiais instalam-se por DOIS canais que ressuscitam cópias: plugin de marketplace
  Claude Code (`enabledPlugins: cloudflare@cloudflare`) e `npx skills add cloudflare/skills`.
  Para manter UMA skill, remover o registo do plugin (settings.json + installed_plugins.json
  + known_marketplaces.json + cache/marketplaces) — reinstalar o plugin traz as 13 de volta.
- `references/upstream/` é um snapshot datado: atualizações do `cloudflare/skills` upstream não
  entram automaticamente; re-sincronizar manualmente e registar aqui.
- A ferramenta expose-port vive em `scripts/expose-port/` (self-contained: DIR = próprio
  diretório, estado `current-link`/logs lá); `install.sh` só instala o atalho
  `expose-port-cloudflare-agent-skill` em `~/.local/bin`.

## 2026-09-25 — pipeline real (Worker + domínio próprio)
- `cf-api.sh`: o heredoc do `python3 -` ENGOLE o pipe — passar dados por ENV, nunca por pipe.
- Workers.dev: conta nova sem visitar a página W&P → erro 10007/`registration declined`;
  resolve-se por API: `PUT /accounts/{acc}/workers/subdomain {"subdomain":"…"}` (sem interface).
- `POST /accounts/{acc}/workers/domains` (custom domains) → 10405 "Method not allowed for this
  authentication scheme" com API tokens; alternativa que funciona: `POST /zones/{zone}/workers/routes`
  {pattern, script} + registo DNS proxied no hostname.
- Pages: `wrangler pages deploy` exige `wrangler pages project create` primeiro.
- Python em scripts: f-strings não aceitam `\"` dentro — usar `%` formatting.

## 2026-09-25 — named tunnel com um token sem Tunnel:Edit
- Token `cfut_` com DNS:Edit + tunnel **read** (`GET /accounts/{acc}/cfd_tunnel` passa) mas
  **sem** `Cloudflare Tunnel:Edit`: `POST .../cfd_tunnel` devolve `10000 Authentication error`.
  Criar túnel exige `Cloudflare Tunnel:Edit` OU o cert do `cloudflared tunnel login`.
  `POST /certificates` (Origin CA) passa auth, mas é outro produto (CSR → cert de servidor).
- `cloudflared tunnel login` é um **long-poll**: o cloudflared espera em
  `https://login.cloudflareaccess.org/<token>` que o browser (QUALQUER aparelho) autorize a zona.
  `Failed to write the certificate ... error=...` é o fallback de "não consegui OBTER o cert":
  `context deadline exceeded` = ninguém clicou (~6–8 min); `Failed to fetch resource` = o browser
  não entregou. Leia o `error=`, não a frase.
- Na página `dash.cloudflare.com/argotunnel` o clique na zona abre um **modal** "Authorize Tunnel
  for <zona>" e só o botão `Authorize` conclui (o overlay não aparece no `body.innerText`).
- Origem com fence de host (só aceita loopback em `/api`) precisa de um proxy que reescreva
  `Host` **e** `Origin`: `originRequest.httpHostHeader` do cloudflared reescreve só o `Host`.

## 2026-09-26 — publicar URL local no domínio próprio = 1 comando (`domain.py`)
- Fonte: utilizador — "pegar `http://127.0.0.1:3080/?token=…` e converter para o meu domínio
  Cloudflare … rapidamente, e derrubar rapidamente". Antes disto o agente montava tudo à mão
  (unit root, proxies soltos, quick tunnel esquecido), demorava ~1h30 e devolvia a URL SEM o
  `?token=`; nada se derrubava pela skill.
- Solução: `scripts/expose-port/domain.py up|down|list|setup|purge` + `zone-runner.mjs`. Um túnel
  por zona e máquina, curinga `*.zona` → túnel (1×), router local por Host com rotas em
  `routes.json` (SIGHUP). Path/query/fragmento preservados na URL pública.
- Medido: registo DNS novo na Cloudflare demora 7–19 s no autoritativo e **8–33 s** a ser
  roteado pela edge; recriar o mesmo host noutro túnel dá 530 durante ~15–25 s (a edge guarda
  host→túnel antigo); PATCH de um CNAME de um túnel para outro converge em 1–3 min (o antigo
  serve entretanto → zero downtime se ficar no ar). Com curinga proxied para um túnel fixo, host
  novo responde em **~0,06 s** → `up` ~0,7 s, `down` ~0,3 s.
- A edge SUBSTITUI um 502 da origem pela página dela (headers custom perdidos) — para distinguir
  "app parada" de "edge sem túnel", o router responde `/__cfx-health` com `x-cfx-proxy: ok`.
- Nunca sondar DNS de um host recém-criado por resolvers recursivos (DoH 1.1.1.1 incluído): um
  NXDOMAIN antes da propagação fica em cache (SOA minimum 1800 s). Perguntar direto ao
  autoritativo da zona (UDP, sem RD) e ligar ao IP da edge com SNI (sem DNS).
- O token dentro do `cert.pem` (bloco `ARGO TUNNEL TOKEN`: accountID, zoneID, apiToken) lê e
  escreve DNS da zona autorizada, lista zonas (só essa) e cria/apaga túneis da conta pela API
  → `cloudflared tunnel login` (1 clique) basta; token de API é opcional.
- Instalação sem sudo e verificada: o corpo do release do cloudflared no GitHub publica
  `<asset>: <sha256>`; nodejs.org publica `SHASUMS256.txt` e `dist/index.json` (1ª entrada com
  `lts` = LTS atual). cloudflared → `~/.local/bin`; Node → pasta privada da skill.
- Duas máquinas na mesma zona não podem partilhar o nome do túnel nem o curinga: nome
  `cfx-<zona>-<id>` e comentário DNS `cfx:<id>:` com `<id>` = 6 hex do sha256 do machine-id
  (o id bruto nunca sai da máquina). Registos de outra máquina contam como terceiros.
- `cloudflared tunnel create -o json` devolve também o `token` do túnel — nunca imprimir.
  `cloudflared 2026.x` corre "connectivity pre-checks" (~1 s) no arranque: `--no-prechecks`.
- `systemctl --user disable` faz daemon-reload (~0,2 s); `--no-reload` basta para units template.
- Atalhos gerados antes de uma fusão/mudança de pasta apontam para caminhos mortos → reinstalar
  com `scripts/expose-port/install.sh`.
- Migração sem downtime de um setup manual: `up … --name @ --alias www --persist --force`
  (PATCH dos CNAMEs), esperar a edge servir 100% pelo router novo (`/__cfx-health`), só então
  desligar e apagar o túnel antigo.
