#!/usr/bin/env bash
# _credentials.sh — carregador de credenciais Cloudflare para os scripts desta skill.
#
# Fontes (por ordem de precedência — a primeira que existir define o valor):
#   1. Variáveis de ambiente já definidas (export CLOUDFLARE_API_TOKEN=…)
#   2. Ficheiro local ~/.config/cloudflare-agent-skill/credentials.env (chmod 600)
#
# O ficheiro local é PARA USO PESSOAL nesta máquina — nunca o escreva dentro do
# repositório da skill e nunca imprima o conteúdo. Só são lídas as variáveis
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL.
#
# Uso:  source "$(dirname "$0")/_credentials.sh"   →  load_cloudflare_credentials
load_cloudflare_credentials() {
  local f="${CLOUDFLARE_CREDENTIALS_FILE:-$HOME/.config/cloudflare-agent-skill/credentials.env}"
  [ -f "$f" ] || return 0
  # Só importa variáveis CLOUDFLARE_* já vazias — o ambiente tem precedência.
  local nome valor
  while IFS='=' read -r nome valor; do
    case "$nome" in
      CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY|CLOUDFLARE_EMAIL)
        if [ -z "${!nome:-}" ]; then export "$nome=$valor"; fi ;;
    esac
  done < "$f"
}
