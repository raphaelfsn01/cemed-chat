#!/usr/bin/env bash
# Teste TRIMESTRAL de restauração do backup externo (runbook:
# docs/runbooks/backup-e-restauracao.md).
#
# Baixa do R2 um conjunto (padrão: o diário completo mais recente), decifra e
# restaura num Postgres 17 descartável — contêiner SEM rede, banco e arquivos
# decifrados em tmpfs (RAM) — e exige que o restaurado bata com o manifest
# gravado no backup: contagem exata de cada tabela de public/auth/storage,
# policies, tabelas com RLS, grants, e cada arquivo de mídia pelo sha256.
# Resultado vai para o check "cemed-restore-trimestral" do healthchecks.io
# (HC_RESTORE_PING_URL); sem o teste por ~3 meses, o healthchecks avisa.
#
# A chave privada NÃO fica na VPS: o script pede para colar (não aparece na tela,
# não vai para o histórico nem para o disco; só passa pelo stdin do contêiner).
#
#   scripts/backup/restore-test.sh                    # diário mais recente
#   scripts/backup/restore-test.sh monthly/2026-11/2026-11-01T081500Z
#
# Precisa só de docker, curl, python3 e jq no host — o age roda no contêiner.
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

BACKUP_ENV="${BACKUP_ENV:-$HOME/.config/cemed-backup/backup.env}"
bk_load_env "$BACKUP_ENV"
bk_require R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
if [ -z "${R2_ENDPOINT:-}" ]; then
  bk_require R2_ACCOUNT_ID
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi
IMAGE=cemed-restore:pg17
TMPFS_SIZE="${RESTORE_TMPFS_SIZE:-3g}"
MIN_FREE_MB="${RESTORE_MIN_FREE_MB:-1500}"

# Máquina compartilhada com a produção: não começa sem folga de memória
# (o banco restaurado vive em RAM).
avail=$(free -m | awk '/^Mem:/{print $7}')
[ "$avail" -ge "$MIN_FREE_MB" ] || bk_die "só ${avail} MB livres (mínimo ${MIN_FREE_MB}); tente num horário mais calmo"

if [ -t 0 ]; then
  printf 'Cole a chave PRIVADA age (AGE-SECRET-KEY-1…) e tecle Enter. Ela não aparece na tela:\n' >&2
  IFS= read -rs KEY
  printf '\n' >&2
else
  KEY=$(grep -m1 '^AGE-SECRET-KEY-1' || true)
fi
[[ $KEY =~ ^AGE-SECRET-KEY-1[0-9A-Z]{58}$ ]] || bk_die "isso não é uma chave privada age (AGE-SECRET-KEY-1…)"

WORK=$(mktemp -d "${RESTORE_TMPDIR:-${TMPDIR:-/tmp}}/cemed-restore.XXXXXX")
CONTAINER="cemed-restore-$$"
printf 'Restaurando num contêiner descartável (1–3 min)…\n' >&2
exec 3>&1 >>"$WORK/run.log" 2>&1

on_exit() {
  local rc=$?
  set +e
  unset KEY
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  if [ "$rc" -ne 0 ]; then
    bk_log "TESTE DE RESTAURAÇÃO FALHOU (código $rc)"
    bk_hc "${HC_RESTORE_PING_URL:-}" /fail "$(tail -n 60 "$WORK/run.log")"
  fi
  cat "$WORK/run.log" >&3
  rm -rf "$WORK"
}
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

[ -n "${HC_RESTORE_PING_URL:-}" ] || bk_log "aviso: HC_RESTORE_PING_URL vazio — o resultado não chega ao healthchecks"
bk_hc "${HC_RESTORE_PING_URL:-}" /start

PREFIX="${1:-}"
if [ -z "$PREFIX" ]; then
  PREFIX=$(bk_s3_keys daily/ | sed -n 's#/manifest\.json\.age$##p' | tail -n 1)
  [ -n "$PREFIX" ] || bk_die "nenhum conjunto completo (com manifest) em daily/"
fi
PREFIX=${PREFIX%/}
bk_log "conjunto: $PREFIX"
for f in manifest.json.age db.dump.age roles.sql.age media.tar.age; do
  bk_s3_get "$PREFIX/$f" "$WORK/$f" || bk_die "não consegui baixar $PREFIX/$f"
done

docker build -q -t "$IMAGE" -f "$HERE/restore.Dockerfile" "$HERE" >/dev/null
# Só os cifrados entram no contêiner (só leitura); nenhuma credencial; sem rede.
printf '%s\n' "$KEY" | docker run --rm -i --name "$CONTAINER" --network none \
  --tmpfs "/var/lib/postgresql/data:rw,size=$TMPFS_SIZE,mode=0700" \
  --tmpfs "/restore:rw,size=$TMPFS_SIZE" \
  -v "$WORK:/in:ro" -v "$HERE:/bk:ro" \
  "$IMAGE" bash /bk/restore-inner.sh
unset KEY

summary="$(grep '^RESUMO ' "$WORK/run.log" | tail -n 1)"
bk_log "RESTAURAÇÃO OK — $PREFIX"
bk_hc "${HC_RESTORE_PING_URL:-}" "" "ok $PREFIX
${summary#RESUMO }"
