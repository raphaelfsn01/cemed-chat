#!/usr/bin/env bash
# Restauração de DESASTRE num projeto Supabase NOVO (runbook:
# docs/runbooks/backup-e-restauracao.md, seção "Desastre").
#
# Baixa do R2 um conjunto, decifra num contêiner descartável (tmpfs) e carrega no
# projeto novo, que precisa estar VAZIO:
#   auth     só os DADOS (o schema é do Supabase) — usuários, senhas (hash), MFA
#   public   tudo: tabelas, dados, funções, policies, grants, publicação realtime
#   storage  dados de buckets/objetos + as NOSSAS policies em storage.objects,
#            e a mídia reenviada pela Storage API no mesmo caminho
# No fim compara com o manifest e diz o que fazer em seguida (trocar o .env).
#
# Credenciais: o R2 vem do backup.env; o projeto novo vem de um arquivo 600
# próprio ($RESTORE_TARGET_ENV, padrão ~/.config/cemed-backup/restore-target.env):
#   TARGET_DB_URL=postgresql://postgres.<ref-novo>:<senha>@<pooler>:5432/postgres
#   TARGET_SUPABASE_URL=https://<ref-novo>.supabase.co
#   TARGET_SERVICE_ROLE_KEY=...
#
#   scripts/backup/restore-supabase.sh [PREFIXO]     # padrão: diário mais recente
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

BACKUP_ENV="${BACKUP_ENV:-$HOME/.config/cemed-backup/backup.env}"
TARGET_ENV="${RESTORE_TARGET_ENV:-$HOME/.config/cemed-backup/restore-target.env}"
bk_load_env "$BACKUP_ENV"
bk_load_env "$TARGET_ENV"
bk_require R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET TARGET_DB_URL TARGET_SUPABASE_URL TARGET_SERVICE_ROLE_KEY
if [ -z "${R2_ENDPOINT:-}" ]; then
  bk_require R2_ACCOUNT_ID
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi
IMAGE=cemed-restore:pg17
TMPFS_SIZE="${RESTORE_TMPFS_SIZE:-3g}"

avail=$(free -m | awk '/^Mem:/{print $7}')
[ "$avail" -ge 1500 ] || bk_die "só ${avail} MB livres (mínimo 1500): a mídia decifrada fica em RAM"

target_host=$(BK_URL="$TARGET_DB_URL" python3 -I -c 'import os,urllib.parse as u; p=u.urlsplit(os.environ["BK_URL"]); print("%s@%s" % (p.username, p.hostname))')
if [ -t 0 ]; then
  printf 'Destino: banco %s, API %s\n' "$target_host" "$TARGET_SUPABASE_URL" >&2
  printf 'Isto CARREGA o backup nesse projeto (que precisa estar vazio). Digite RESTAURAR: ' >&2
  IFS= read -r confirm
  [ "$confirm" = RESTAURAR ] || bk_die "cancelado"
  printf 'Cole a chave PRIVADA age (AGE-SECRET-KEY-1…) e tecle Enter. Ela não aparece na tela:\n' >&2
  IFS= read -rs KEY
  printf '\n' >&2
else
  [ "${RESTORE_CONFIRM:-}" = RESTAURAR ] || bk_die "sem terminal: exporte RESTORE_CONFIRM=RESTAURAR para confirmar"
  KEY=$(grep -m1 '^AGE-SECRET-KEY-1' || true)
fi
[[ $KEY =~ ^AGE-SECRET-KEY-1[0-9A-Z]{58}$ ]] || bk_die "isso não é uma chave privada age (AGE-SECRET-KEY-1…)"

WORK=$(mktemp -d "${RESTORE_TMPDIR:-${TMPDIR:-/tmp}}/cemed-restore.XXXXXX")
CONTAINER="cemed-restore-supabase-$$"
cleanup() {
  unset KEY
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

PREFIX="${1:-}"
if [ -z "$PREFIX" ]; then
  PREFIX=$(bk_s3_keys daily/ | sed -n 's#/manifest\.json\.age$##p' | tail -n 1)
  [ -n "$PREFIX" ] || bk_die "nenhum conjunto completo (com manifest) em daily/"
fi
PREFIX=${PREFIX%/}
bk_log "conjunto: $PREFIX → $target_host"
for f in manifest.json.age db.dump.age roles.sql.age media.tar.age; do
  bk_s3_get "$PREFIX/$f" "$WORK/$f" || bk_die "não consegui baixar $PREFIX/$f"
done

docker build -q -t "$IMAGE" -f "$HERE/restore.Dockerfile" "$HERE" >/dev/null
# Chave e credenciais do destino entram pelo stdin (não ficam no `docker inspect`).
# RESTORE_DOCKER_NETWORK existe para o ensaio local, num Supabase da CLI.
printf '%s\n' "$KEY" "TARGET_DB_URL=$TARGET_DB_URL" "TARGET_SUPABASE_URL=$TARGET_SUPABASE_URL" \
  "TARGET_SERVICE_ROLE_KEY=$TARGET_SERVICE_ROLE_KEY" \
  | docker run --rm -i --name "$CONTAINER" --network "${RESTORE_DOCKER_NETWORK:-bridge}" \
    --tmpfs "/restore:rw,size=$TMPFS_SIZE" -v "$WORK:/in:ro" -v "$HERE:/bk:ro" \
    "$IMAGE" bash /bk/restore-supabase-inner.sh
