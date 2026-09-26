#!/usr/bin/env bash
# cloudflare-doctor.sh — diagnóstico READ-ONLY do ambiente Cloudflare.
# Nunca imprime valores de segredos: apenas presença/máscara.
# Exit codes: 0 ok · 1 problema operacional · 2 uso inválido · 3 ferramenta em falta
set -uo pipefail

# Credenciais locais (env tem precedência) — ~/.config/cloudflare-agent-skill/credentials.env
_HERE_CRED="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_HERE_CRED/_credentials.sh" ] && { . "$_HERE_CRED/_credentials.sh"; load_cloudflare_credentials; }

usage(){ sed -n '2,5p' "$0"; exit 0; }
[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && usage
[ "${1:-}" = "selftest" ] && { echo "selftest OK — doctor offline"; exit 0; }

mask(){ # mask <valor> → "cfut_…(37 chars)" sem vazar o miolo
  local v="${1:-}"
  [ -z "$v" ] && { echo "—"; return; }
  echo "${v:0:5}…(${#v} chars)"
}

MISSING=0
printf '%-22s %-10s %s\n' "COMPONENTE" "ESTADO" "DETALHE"
printf '%-22s %-10s %s\n' "----------------------" "----------" "------------------------------"

# 1. Node / npm (base para wrangler/npx)
if command -v node >/dev/null 2>&1; then
  printf '%-22s %-10s %s\n' "node" "ok" "$(node -v)"
else
  printf '%-22s %-10s %s\n' "node" "FALTA" "Erro: node não instalado — Solução: python3 scripts/expose-port/domain.py setup --deps (sem sudo)"
  MISSING=1
fi

# 2. wrangler
if command -v wrangler >/dev/null 2>&1; then
  printf '%-22s %-10s %s\n' "wrangler" "ok" "$(wrangler --version 2>/dev/null | head -1)"
else
  printf '%-22s %-10s %s\n' "wrangler" "global FALTA" "usável via npx wrangler (local em projetos) · global: npm i -g wrangler"
fi

# 3. cloudflared (túneis)
if command -v cloudflared >/dev/null 2>&1; then
  printf '%-22s %-10s %s\n' "cloudflared" "ok" "$(cloudflared --version 2>/dev/null | head -1)"
else
  printf '%-22s %-10s %s\n' "cloudflared" "FALTA" "instalar: python3 scripts/expose-port/domain.py setup --deps (binário oficial, sem sudo)"
fi

# 4. curl (API v4)
if command -v curl >/dev/null 2>&1; then
  printf '%-22s %-10s %s\n' "curl" "ok" "$(curl --version 2>/dev/null | head -1 | cut -c1-40)"
else
  printf '%-22s %-10s %s\n' "curl" "FALTA" "Erro: curl necessário para cf-api.sh — Solução: instalar curl pelo gestor de pacotes (apt/dnf/pacman/brew)"
  MISSING=1
fi

# 5. Autenticação (SEMPRE mascarada)
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  printf '%-22s %-10s %s\n' "CLOUDFLARE_API_TOKEN" "definido" "valor: $(mask "$CLOUDFLARE_API_TOKEN")"
else
  printf '%-22s %-10s %s\n' "CLOUDFLARE_API_TOKEN" "ausente" "criar token cfut_… (ver references/auth-and-tokens.md) e exportar"
fi
if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  printf '%-22s %-10s %s\n' "CLOUDFLARE_ACCOUNT_ID" "definido" "valor: $(mask "$CLOUDFLARE_ACCOUNT_ID")"
else
  printf '%-22s %-10s %s\n' "CLOUDFLARE_ACCOUNT_ID" "ausente" "opcional p/ wrangler; obtém-se com: bash scripts/cf-api.sh GET /accounts"
fi

# 6. Validação ao vivo do token (só se existir; read-only)
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && command -v curl >/dev/null 2>&1; then
  RESP="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
          https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null)"
  case "$RESP" in
    200) printf '%-22s %-10s %s\n' "token verify" "ok" "token ativo e válido" ;;
    401|403) printf '%-22s %-10s %s\n' "token verify" "INVÁLIDO" "Erro: HTTP $RESP — Solução: token expirado/revogado; criar novo em dash.cloudflare.com/profile/api-tokens" ;;
    000)   printf '%-22s %-10s %s\n' "token verify" "sem rede" "não foi possível contactar api.cloudflare.com" ;;
    *)     printf '%-22s %-10s %s\n' "token verify" "HTTP $RESP" "ver references/troubleshooting.md" ;;
  esac
fi

# 7. Publicar URL local no domínio (scripts/expose-port/domain.py) — read-only
if [ -n "${CLOUDFLARE_EXPOSE_DOMAIN:-}" ]; then
  printf '%-22s %-10s %s\n' "expose dominio" "ok" "$CLOUDFLARE_EXPOSE_DOMAIN (domain.py up '<url>' usa este por omissão)"
else
  printf '%-22s %-10s %s\n' "expose dominio" "ausente" "definir CLOUDFLARE_EXPOSE_DOMAIN=<zona> em ~/.config/cloudflare-agent-skill/config.env"
fi
if [ -f "${TUNNEL_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}" ]; then
  printf '%-22s %-10s %s\n' "cert.pem (tuneis)" "ok" "túneis + DNS da zona autorizada (domain.py)"
else
  printf '%-22s %-10s %s\n' "cert.pem (tuneis)" "ausente" "python3 scripts/expose-port/domain.py setup (faz o login no browser)"
fi

echo
if [ "$MISSING" -eq 1 ]; then
  echo "Erro: ferramentas base em falta (ver tabela) — Solução: instalar as dependências assinaladas antes de operar o Cloudflare."
  exit 3
fi
echo "Ambiente verificado (read-only). Próximo passo: bash scripts/cf-api.sh GET /zones"
