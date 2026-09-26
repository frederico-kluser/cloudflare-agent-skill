#!/usr/bin/env bash
# cf-api.sh — wrapper determinístico da Cloudflare API v4.
#   GET paginado automático · JSON validado · erros no formato Erro/Solução · saída truncada.
# Uso:
#   cf-api.sh GET  /zones [parâmetros-query]
#   cf-api.sh GET  /zones/<id>/dns_records
#   cf-api.sh POST /zones/<id>/dns_records  '<json>'
#   cf-api.sh PATCH|PUT|DELETE /caminho ['<json>']
#   cf-api.sh --selftest
# Env: CLOUDFLARE_API_TOKEN (obrigatório) · CLOUDFLARE_ACCOUNT_ID (opcional)
# Exit: 0 ok · 1 erro operacional · 2 uso inválido · 3 dependência/token em falta
set -uo pipefail

# Credenciais locais (env tem precedência) — ~/.config/cloudflare-agent-skill/credentials.env
_HERE_CRED="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_HERE_CRED/_credentials.sh" ] && { . "$_HERE_CRED/_credentials.sh"; load_cloudflare_credentials; }
API="https://api.cloudflare.com/client/v4"
MAX_BYTES=49152   # portão de saída: 48 KB

selftest(){ echo "selftest OK — cf-api.sh offline (sem chamadas de rede)"; exit 0; }
usage(){ sed -n '2,11p' "$0"; exit 0; }

[ $# -ge 1 ] || usage
[ "$1" = "--selftest" ] && selftest
[ "$1" = "--help" ] || [ "$1" = "-h" ] && usage

METHOD="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
PATH_="${2:-}"
BODY="${3:-}"

case "$METHOD" in GET|POST|PUT|PATCH|DELETE) ;; *)
  echo "Erro: método '$METHOD' não suportado — Solução: use GET, POST, PUT, PATCH ou DELETE."; exit 2 ;;
esac
[ -n "$PATH_" ] || { echo "Erro: caminho da API em falta — Solução: ex. GET /zones?name=example.com"; exit 2; }
case "$PATH_" in /*) ;; *) PATH_="/$PATH_" ;; esac

command -v curl >/dev/null 2>&1 || { echo "Erro: curl não instalado — Solução: instalar curl pelo gestor de pacotes (apt/dnf/pacman/brew)"; exit 3; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || {
  echo "Erro: CLOUDFLARE_API_TOKEN não definido — Solução: export CLOUDFLARE_API_TOKEN=cfut_… (criar em dash.cloudflare.com/profile/api-tokens; ver references/auth-and-tokens.md)"; exit 3; }

request(){ # request <url> [data] → imprime corpo; exit code reflete HTTP
  local url="$1" data="${2:-}"
  local args=(-sS -X "$METHOD" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(-d "$data")
  curl "${args[@]}" "$url"
}

RAW="$(request "$API$PATH_" "$BODY")" || {
  echo "Erro: falha de rede a contactar api.cloudflare.com — Solução: verificar conectividade/proxy e repetir"; exit 1; }

# Resposta curta e óbvia? Encaminha o erro da API no formato instrutivo.
if command -v python3 >/dev/null 2>&1; then
  # NOTA: o heredoc do python3 - substitui o stdin, por isso o RAW viaja por ENV
  # (não por pipe — pipe seria engolido pelo heredoc).
  RAW_TRUNC="$(printf '%s' "$RAW" | head -c "$MAX_BYTES")"
  RAW_TRUNC="$RAW_TRUNC" python3 - "$METHOD" "$PATH_" <<'PY'
import json, os, sys
method, path = sys.argv[1], sys.argv[2]
raw = os.environ.get("RAW_TRUNC", "")
try:
    doc = json.loads(raw)
except Exception:
    print(raw[:2000]); sys.exit(0)
if isinstance(doc, dict) and doc.get("success") is False:
    errs = doc.get("errors") or [{"code": 0, "message": "sem detalhe"}]
    e = errs[0]
    code, msg = e.get("code"), e.get("message", "")
    hints = {
        10000: "autenticação falhou — Solução: token inválido/sem permissão; conferir CLOUDFLARE_API_TOKEN e escopos (references/auth-and-tokens.md)",
        91098002: "erro de validação — Solução: conferir o corpo JSON e os nomes dos campos (references/api-v4.md)",
        1049: "recurso não existe — Solução: conferir o id/nome (GET /zones?name=…)",
        81044: "zona inativa — Solução: concluir a ativação dos nameservers antes de operar sobre a zona",
        9106: "zona precisa de plano pago para esta feature — Solução: verificar limites do plano Free",
        7003: "query inválida — Solução: conferir parâmetros da query string",
    }
    hint = hints.get(code, "ver references/troubleshooting.md")
    print(f"Erro: Cloudflare API {method} {path} → HTTP-error code {code}: {msg} — {hint}")
    sys.exit(1)
print(json.dumps(doc, indent=2, ensure_ascii=False)[:49152])
PY
  EXIT=$?
  # GET paginado: se houver mais páginas, avisa (não decide pelo agente)
  if [ "$EXIT" -eq 0 ] && [ "$METHOD" = "GET" ]; then
    TOTAL_PAGES="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("result_info") or {}).get("total_pages",1))' 2>/dev/null || echo 1)"
    CUR_PAGE="$(printf '%s' "$RAW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("result_info") or {}).get("page",1))' 2>/dev/null || echo 1)"
    if [ "${TOTAL_PAGES:-1}" -gt "${CUR_PAGE:-1}" ]; then
      echo "» paginação: página $CUR_PAGE de $TOTAL_PAGES — acrescente ?page=N para as seguintes (ou ?per_page=50)" >&2
    fi
  fi
  exit "$EXIT"
else
  echo "Erro: python3 não instalado (necessário para validar JSON) — Solução: instalar python3 pelo gestor de pacotes"; exit 3
fi
