#!/usr/bin/env bash
# cf-dns.sh — CRUD determinístico de registos DNS (API v4), com resolução de
# zona por NOME (nunca exige memorizar zone ids).
# Uso:
#   cf-dns.sh list <zona>                      # lista registos (tabela curta)
#   cf-dns.sh add <zona> <nome> <tipo> <conteúdo> [--proxied] [--ttl N]
#   cf-dns.sh update <zona> <record_id> [--content X] [--proxied|--no-proxied] [--ttl N]
#   cf-dns.sh delete <zona> <record_id>        # pede confirmação textual
#   cf-dns.sh find <zona> <nome-ou-tipo>       # pesquisa por nome/tipo
#   cf-dns.sh --selftest
# Env: CLOUDFLARE_API_TOKEN · saída ≤ 48 KB · Exit: 0/1/2/3 como cf-api.sh
set -uo pipefail

# Credenciais locais (env tem precedência) — ~/.config/cloudflare-agent-skill/credentials.env
_HERE_CRED="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_HERE_CRED/_credentials.sh" ] && { . "$_HERE_CRED/_credentials.sh"; load_cloudflare_credentials; }
HERE="$(cd "$(dirname "$0")" && pwd)"
CF_API="$HERE/cf-api.sh"

die(){ echo "Erro: $1 — Solução: $2"; exit "${3:-1}"; }
[ "${1:-}" = "--selftest" ] && { echo "selftest OK — cf-dns.sh offline"; exit 0; }
[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && sed -n '2,11p' "$0" && exit 0
[ $# -ge 2 ] || { sed -n '2,11p' "$0"; exit 2; }

CMD="$1"; ZONE="$2"

zone_id(){ # zone_id <nome> → id (determinístico; falha instrutiva se 0/2+)
  local out id
  out="$(bash "$CF_API" GET "/zones?name=$ZONE" 2>/dev/null)" || die "zona '$ZONE' não consultável" "conferir CLOUDFLARE_API_TOKEN e grafia da zona" 1
  id="$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result") or []; print(r[0]["id"] if len(r)==1 else "")' 2>/dev/null)"
  [ -n "$id" ] || die "zona '$ZONE' não encontrada (0 ou múltiplos resultados)" "conferir nome exato: bash scripts/cf-api.sh GET /zones?name=$ZONE" 1
  printf '%s' "$id"
}

case "$CMD" in
  list|find)
    ZID="$(zone_id)"
    if [ "$CMD" = "find" ] && [ -n "${3:-}" ]; then
      Q="$3"
      bash "$CF_API" GET "/zones/$ZID/dns_records?per_page=100" | python3 -c '
import json,sys
q=sys.argv[1].lower()
d=json.load(sys.stdin)
for r in d.get("result") or []:
    if q in (r.get("name","").lower() + r.get("type","").lower()):
        print(f'"'"'{r["id"]}  {r["type"]:<7} {r["name"]}  →  {r.get("content","")}  proxied={r.get("proxied")} ttl={r.get("ttl")}'"'"')
' "$Q"
    else
      bash "$CF_API" GET "/zones/$ZID/dns_records?per_page=100" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print(f'"'"'{"ID":<34} {"TIPO":<7} {"NOME":<32} CONTEÚDO'"'"')
for r in d.get("result") or []:
    print(f'"'"'{r["id"]:<34} {r["type"]:<7} {r["name"]:<32} {r.get("content","")}'"'"')
print(f'"'"'— {len(d.get("result") or [])} registo(s)'"'"')
'
    fi
    ;;

  add)
    [ $# -ge 5 ] || die "uso: add <zona> <nome> <tipo> <conteúdo> [--proxied] [--ttl N]" "completar argumentos (ver --help)" 2
    NAME="$3"; TYPE="$4"; CONTENT="$5"; shift 5
    PROXIED=false; TTL=1
    while [ $# -gt 0 ]; do
      case "$1" in
        --proxied) PROXIED=true ;;
        --no-proxied) PROXIED=false ;;
        --ttl) TTL="${2:-1}"; shift ;;
        *) die "opção desconhecida '$1'" "usar --proxied, --no-proxied ou --ttl N" 2 ;;
      esac
      shift
    done
    ZID="$(zone_id)"
    BODY="$(python3 -c 'import json,sys; print(json.dumps({"type":sys.argv[1],"name":sys.argv[2],"content":sys.argv[3],"ttl":int(sys.argv[4]),"proxied":sys.argv[5]=="true"}))' "$TYPE" "$NAME" "$CONTENT" "$TTL" "$PROXIED")"
    bash "$CF_API" POST "/zones/$ZID/dns_records" "$BODY" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if d.get("success"):
    r=d["result"]
    print("OK: criado %s %s → %s (id %s, proxied=%s)" % (r.get("type"), r.get("name"), r.get("content"), r.get("id"), r.get("proxied")))
else:
    print(json.dumps(d, indent=2))
'
    ;;

  update)
    [ $# -ge 3 ] || die "uso: update <zona> <record_id> [--content X] [--proxied|--no-proxied] [--ttl N]" "completar argumentos (ver --help)" 2
    RID="$3"; shift 3
    PATCH='{}'
    while [ $# -gt 0 ]; do
      case "$1" in
        --content) PATCH="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["content"]=sys.argv[2]; print(json.dumps(d))' "$PATCH" "${2:-}")"; shift ;;
        --proxied) PATCH="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["proxied"]=True; print(json.dumps(d))' "$PATCH")" ;;
        --no-proxied) PATCH="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["proxied"]=False; print(json.dumps(d))' "$PATCH")" ;;
        --ttl) PATCH="$(python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d["ttl"]=int(sys.argv[2]); print(json.dumps(d))' "$PATCH" "${2:-1}")"; shift ;;
        *) die "opção desconhecida '$1'" "usar --content, --proxied/--no-proxied ou --ttl N" 2 ;;
      esac
      shift
    done
    ZID="$(zone_id)"
    bash "$CF_API" PATCH "/zones/$ZID/dns_records/$RID" "$PATCH"
    ;;

  delete)
    [ $# -ge 3 ] || die "uso: delete <zona> <record_id>" "completar argumentos (ver --help)" 2
    RID="$3"
    echo "ATENÇÃO: vai APAGAR o registo DNS $RID da zona $ZONE."
    printf 'Confirme escrevendo o record_id: '
    read -r CONF
    [ "$CONF" = "$RID" ] || die "confirmação não coincidiu (escreveu '$CONF')" "repetir e digitar exatamente o record_id" 1
    ZID="$(zone_id)"
    bash "$CF_API" DELETE "/zones/$ZID/dns_records/$RID"
    ;;

  *)
    die "comando desconhecido '$CMD'" "usar list, add, update, delete ou find (ver --help)" 2
    ;;
esac
