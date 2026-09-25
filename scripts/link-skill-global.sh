#!/usr/bin/env bash
# link-skill-global.sh — regista ESTA skill, por symlink, em todos os skill roots
# globais de agentes desta máquina (Claude Code, opencode, codex, …). Idempotente.
# Uso:  ./link-skill-global.sh [--check] [--dry-run]
set -uo pipefail

SKILL_NAME="$(basename "$(cd "$(dirname "$0")/.." && pwd)")"
SRC="$(readlink -f "$(cd "$(dirname "$0")/.." && pwd)")"
BAK_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/cloudflare-agent-skill/link-backups"

MODE=apply
while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE=check ;;
    --dry-run) MODE=dryrun ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

ok(){ printf '  \033[32mOK\033[0m   %s\n' "$*"; }
skip(){ printf '  \033[36mSKIP\033[0m %s\n' "$*"; }
act(){ printf '  \033[33mACT\033[0m  %s\n' "$*"; }
err(){ printf '  \033[31mERR\033[0m  %s\n' "$*" >&2; }
hdr(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }

FAIL=0
TS="$(date +%Y%m%d-%H%M%S)"

hdr "0. Preflight — $SKILL_NAME"
[ -f "$SRC/SKILL.md" ] || { err "fonte inválida: $SRC/SKILL.md não existe"; exit 1; }
ok "fonte: $SRC"

# Frontmatter estrutural (delimitadores + name/description não vazios + name == diretório)
if ! awk -v want="$SKILL_NAME" '
  NR==1 && $0!="---" { print "sem frontmatter"; exit 1 }
  NR>1 && $0=="---"  { end=1; exit }
  /^name:/        { sub(/^name:[ \t]*/,""); n=$0 }
  /^description:/ { sub(/^description:[ \t]*/,""); d=$0 }
  END { if(!end||n==""||d==""){print "frontmatter incompleto"; exit 1}
        if(n!=want){print "name="n" != "want; exit 1} }
' "$SRC/SKILL.md" >/dev/null 2>&1; then
  err "frontmatter inválido em $SRC/SKILL.md (precisa de name == '$SKILL_NAME' e description)"; exit 1
fi
ok "frontmatter válido"

hdr "1. Descoberta dos skill roots globais"
declare -a ROOTS=() WHY=()
add_root(){ [ -d "$1" ] || { skip "$3 — home ausente ($1)"; return; }; ROOTS+=("$2"); WHY+=("$3"); }
add_root "$HOME/.agents"          "$HOME/.agents/skills"          "universal (~/.agents: vários agentes + opencode)"
add_root "$HOME/.claude"          "$HOME/.claude/skills"          "Claude Code (perfil default) + opencode external"
add_root "$HOME/.jcode"           "$HOME/.jcode/skills"           "jcode (root global próprio)"
add_root "$HOME/.pi/agent"        "$HOME/.pi/agent/skills"        "pi-coding-agent (<agentDir>/skills)"
add_root "$HOME/.dsh"             "$HOME/.dsh/skills"             "dsh (DeepSeek Harness)"
add_root "$HOME/.config/opencode" "$HOME/.config/opencode/skill"  "opencode (global, dir no singular)"
add_root "$HOME/.codex"           "$HOME/.codex/skills"           "codex (preventivo)"
for home in "$HOME"/.claude-*; do
  [ -d "$home" ] || continue
  case "$home" in *.claude-cred-backups) continue ;; esac
  if [ -f "$home/.claude.json" ] || [ -f "$home/settings.json" ]; then
    add_root "$home" "$home/skills" "conta Claude $(basename "$home")"
  fi
done
printf '  %d roots\n' "${#ROOTS[@]}"

hdr "2. Symlinks"
for i in "${!ROOTS[@]}"; do
  root="${ROOTS[$i]}"; why="${WHY[$i]}"; dest="$root/$SKILL_NAME"
  if [ ! -d "$root" ]; then
    if [ "$MODE" = apply ]; then mkdir -p "$root" && act "$root — root criado"; else skip "$root (seria criado)"; fi
  fi
  if [ -L "$dest" ]; then
    cur="$(readlink -f "$dest" 2>/dev/null || true)"
    if [ "$cur" = "$SRC" ]; then ok "$dest — já correto ($why)"; continue; fi
    if [ "$MODE" = apply ]; then
      mkdir -p "$BAK_ROOT/$TS"; mv "$dest" "$BAK_ROOT/$TS/" && act "$dest — link divergente movido para backup"
    else
      act "$dest — link divergente seria movido ($why)"; continue
    fi
  elif [ -e "$dest" ]; then
    if [ "$MODE" = apply ]; then
      mkdir -p "$BAK_ROOT/$TS"; mv "$dest" "$BAK_ROOT/$TS/" && act "$dest — diretório real movido para backup"
    else
      act "$dest — diretório real seria movido ($why)"; continue
    fi
  fi
  if [ "$MODE" = apply ]; then
    ln -s "$SRC" "$dest" && act "$dest → $SRC ($why)"
  else
    act "$dest → $SRC (seria criado) ($why)"
  fi
done

hdr "3. Resultado"
if [ "$MODE" = check ]; then
  FAIL=0
  for i in "${!ROOTS[@]}"; do
    dest="${ROOTS[$i]}/$SKILL_NAME"
    [ "$(readlink -f "$dest" 2>/dev/null)" = "$SRC" ] || FAIL=1
  done
  [ "$FAIL" -eq 0 ] && ok "todos os roots em conformidade" || { err "há roots fora de conformidade"; exit 1; }
else
  ok "concluído (modo: $MODE)"
fi
