#!/usr/bin/env bash
# _credentials.sh — carregador de credenciais Cloudflare para os scripts desta skill.
#
# Fontes (por ordem de precedência — a primeira que existir define o valor):
#   1. Variáveis de ambiente já definidas (export CLOUDFLARE_API_TOKEN=…)
#   2. Ficheiro local ~/.config/cloudflare-agent-skill/credentials.env (chmod 600, segredos)
#   3. Ficheiro local ~/.config/cloudflare-agent-skill/config.env (preferências, sem segredos:
#      CLOUDFLARE_EXPOSE_DOMAIN = domínio por omissão do expose-port/domain.py)
#
# Os ficheiros locais são PARA USO PESSOAL nesta máquina — nunca os escreva dentro do
# repositório da skill e nunca imprima o conteúdo. Só são lídas as variáveis
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL,
# CLOUDFLARE_EXPOSE_DOMAIN, CLOUDFLARE_EXPOSE_WILDCARD.
#
# Uso:  source "$(dirname "$0")/_credentials.sh"   →  load_cloudflare_credentials
load_cloudflare_credentials() {
  local f nome valor
  for f in "${CLOUDFLARE_CREDENTIALS_FILE:-$HOME/.config/cloudflare-agent-skill/credentials.env}" \
           "$HOME/.config/cloudflare-agent-skill/config.env"; do
    [ -f "$f" ] || continue
    # Só importa variáveis CLOUDFLARE_* já vazias — o ambiente tem precedência.
    while IFS='=' read -r nome valor; do
      case "$nome" in
        CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL|CLOUDFLARE_EXPOSE_DOMAIN|CLOUDFLARE_EXPOSE_WILDCARD)
          if [ -z "${!nome:-}" ]; then export "$nome=$valor"; fi ;;
      esac
    done < "$f"
  done
}
