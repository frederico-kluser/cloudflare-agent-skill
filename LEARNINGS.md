# LEARNINGS — cloudflare-agent-skill

Registo de aprendizados (fonte: usuário > docs oficial > inferência). Data primeiro.

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

## 2026-09-25 — fusão das 15 skills Cloudflare nesta skill (v2.0.0)
- Fonte: pedido do usuário ("quero ter uma só que saiba tudo e faça tudo"). Foram fundidas
  13 skills oficiais (`cloudflare`, `wrangler`, `workers-best-practices`, `durable-objects`,
  `agents-sdk`, `cloudflare-email-service`, `cloudflare-one`, `cloudflare-one-migrations`,
  `turnstile-spin`, `sandbox-stable`, `sandbox-next`, `sandbox-migrate-to-next`,
  `nextjs-on-cloudflare`) + `expose-port-cloudflare-agent-skill`; as antigas foram apagadas
  dos catálogos (`~/.agents/skills`, `~/.claude/skills`, `~/.jcode/skills`).
- Arquitetura: `SKILL.md` = roteador enxuto + `references/*.md` = módulos destilados (PT-PT)
  + `references/upstream/<skill>/` = snapshot verbatim (sem SKILL.md) das skills oficiais
  (repo `cloudflare/skills`, plugin `cloudflare@cloudflare` v1.0.0) — carregamento progressivo.
- As skills oficiais instalam-se por DOIS canais que ressuscitam cópias: plugin de marketplace
  Claude Code (`enabledPlugins: cloudflare@cloudflare`) e `npx skills add cloudflare/skills`.
  Para manter UMA skill, o registo do plugin foi removido (settings.json + installed_plugins.json
  + known_marketplaces.json + cache/marketplaces) — se voltar a instalar o plugin, as 13 skills
  reaparecem e voltam a competir no catálogo.
- `references/upstream/` é um snapshot datado: atualizações do `cloudflare/skills` upstream não
  entram automaticamente; re-sincronizar manualmente e registar aqui.
- A ferramenta expose-port foi movida para `scripts/expose-port/` (self-contained: DIR = próprio
  diretório, estado `current-link`/logs vivem lá); `install.sh` já não regista skill separada —
  só instala o atalho `expose-port-cloudflare-agent-skill` em `~/.local/bin`.

## 2026-09-25 — pipeline real (Worker + domínio próprio)
- `cf-api.sh`: o heredoc do `python3 -` ENGOLE o pipe — passar dados por ENV, nunca por pipe.
- Workers.dev: conta nova sem visitar a página W&P → erro 10007/`registration declined`;
  resolve-se por API: `PUT /accounts/{acc}/workers/subdomain {"subdomain":"…"}` (sem interface).
- `POST /accounts/{acc}/workers/domains` (custom domains) → 10405 "Method not allowed for this
  authentication scheme" com API tokens; alternativa que funciona: `POST /zones/{zone}/workers/routes`
  {pattern, script} + registo DNS proxied no hostname.
- Pages: `wrangler pages deploy` exige `wrangler pages project create` primeiro.
- Python em scripts: f-strings não aceitam `\"` dentro — usar `%` formatting.
