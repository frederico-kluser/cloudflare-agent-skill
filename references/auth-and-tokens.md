# Autenticação e tokens (referência nível 3)

## Formas de autenticar (ordem de preferência)

1. **API Token escopado (`cfut_…`)** — o padrão. Vive em `CLOUDFLARE_API_TOKEN`.
2. **Wrangler OAuth** — `npx wrangler login` (abre browser; tokens próprios do
   wrangler em `~/.wrangler/config/`). Bom para dev humano, não para CI.
3. **Global API Key** (legada) — `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`.
   Evitar: dá acesso total à conta.

## Criar o token (dashboard)

1. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**.
2. Template **Edit Cloudflare Workers** ou custom. Permissões mínimas por caso:

| Uso | Permissões (Group · Permission · Level) |
|---|---|
| Deploy Workers (wrangler) | Account · Workers Scripts · Edit |
| Deploy Pages | Account · Cloudflare Pages · Edit |
| DNS automatizado | Zone · DNS · Edit (zona específica) |
| Domínio próprio no Worker | Zone · Workers Routes · Edit |
| Read-only/doctor | Account · Account Settings · Read |
| CI completo (GitHub Actions) | + Account · Workers Tail · Read, User · User Details · Read |

3. **Account Resources**: incluir apenas a conta alvo. **Zone Resources**: zona
   específica (ex. `example.com`) ou *All zones* se as permissões forem só
   de Account. **TTL**: 30 dias é boa higiene.
4. **Create Token** → copiar `cfut_…` (mostrado UMA vez).

> Nota: "Zone Resources" só lista zonas que JÁ existem na conta. Um domínio
> comprado noutro registrar (ex. GoDaddy) só aparece depois de "Add site" +
> troca de nameservers — ver troubleshooting (domínio pendente).

## Exportar no ambiente

```bash
export CLOUDFLARE_API_TOKEN="cfut_…"      # NUNCA commitar; ideal: gerenciador de segredos
export CLOUDFLARE_ACCOUNT_ID="…"          # opcional p/ wrangler (GET /accounts)
```

Nunca ler ficheiros de segredos alheios (`~/.secrets`, `.git-credentials`) — apenas
documentar nomes/caminhos.

## Verificar e rotacionar

```bash
bash scripts/cloudflare-doctor.sh                    # read-only, mascara tudo
bash scripts/cf-api.sh GET /user/tokens/verify        # 200 = token vivo
```

Rotação: criar token novo → testar → revogar o antigo em
**API Tokens → Roll/Revoke**. Um token vazado rotaciona-se IMEDIATAMENTE.

## Permissões para domínio próprio (workflow completo)

1. Adicionar o domínio à conta (**Add site** → plano Free) → obter 2 NS
   `*.ns.cloudflare.com`.
2. No registrar: desativar **DNSSEC** (crítico!) e apontar nameservers para os NS.
3. Esperar zona `active` (`GET /zones?name=…` → `status`).
4. Token precisa de `Zone · Workers Routes · Edit` (+ `Zone · DNS · Edit` para
   criar registos por API).
5. `wrangler.toml`: `[[routes]] pattern = "api.example.com" custom_domain = true`.

## CI/CD (GitHub Actions)

```yaml
env:
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
# usar token com escopo mínimo + TTL curto; NUNCA echo do token nos logs
```
