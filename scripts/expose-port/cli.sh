#!/usr/bin/env bash
# expose-port-cloudflare-agent-skill CLI entry — dispatches subcommands to the scripts.
#
#   SEU DOMÍNIO (named tunnel, domain.py — o modo principal):
#   expose-port-cloudflare-agent-skill up <url> [--domain D] [--name N] [--persist] …
#       publica <url> em https://<host>.<domínio>, preservando path/query (?token=…)
#   expose-port-cloudflare-agent-skill down <host|label|porta|all>   derruba (404 na hora)
#   expose-port-cloudflare-agent-skill ls                            rotas publicadas
#   expose-port-cloudflare-agent-skill purge <zona|all>              remove túnel/curinga/DNS da skill
#   expose-port-cloudflare-agent-skill setup [--check]               prepara a máquina sozinho (instala, login, permissões)
#
#   QUICK TUNNEL (trycloudflare, sem conta, senha ?key= + QR):
#   expose-port-cloudflare-agent-skill <target>   expose a local server
#     <target> = 8080 | host:port | http(s)://host:port[/path]
#   expose-port-cloudflare-agent-skill list       what is running now (read-only)
#   expose-port-cloudflare-agent-skill stop       stop the tracked tunnel + proxy
#   expose-port-cloudflare-agent-skill stop-all   stop every quick tunnel + gate proxy
#   expose-port-cloudflare-agent-skill help       this help
#
# Installed as ~/.local/bin/expose-port-cloudflare-agent-skill by install.sh; re-run
# install.sh to refresh it. Arguments after the subcommand pass through.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/." && pwd)"

case "${1:-}" in
  up|down|purge|setup) exec python3 "$DIR/domain.py" "$@" ;;
  ls|shares) shift; exec python3 "$DIR/domain.py" list "$@" ;;
  list) shift; exec "$DIR/list.sh" "$@" ;;
  stop) shift; exec "$DIR/stop.sh" "$@" ;;
  stop-all|stopall|stopAll) shift; exec "$DIR/stop-all.sh" "$@" ;;
  --help|-h|help)
    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  '')
    echo "usage: expose-port-cloudflare-agent-skill up <url> [--domain D] | down <host> | ls | purge <zona>" >&2
    echo "       expose-port-cloudflare-agent-skill <http://host:port | host:port | port>   (quick tunnel)" >&2
    echo "       expose-port-cloudflare-agent-skill list | stop | stop-all" >&2
    exit 2 ;;
  *) exec "$DIR/expose-port.sh" "$@" ;;
esac
