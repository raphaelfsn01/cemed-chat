#!/usr/bin/env bash
# Backup diário externo do CEMED Chat (auditoria 2026-10-21, achado A1).
#
# O que sai, cifrado com age ANTES de deixar a máquina, para o Cloudflare R2:
#   db.dump.age        pg_dump --format=custom de public+auth+storage, COM donos e
#                      grants (as policies RLS e o acesso de anon/authenticated
#                      dependem deles)
#   roles.sql.age      pg_dumpall --roles-only --no-role-passwords
#   media.tar.age      objetos dos buckets de mídia (padrão: whatsapp-media)
#   manifest.json.age  contagem de linhas de cada tabela NO MESMO SNAPSHOT do dump,
#                      policies, grants, tamanhos e sha256 dos cifrados
#
# Chaves: daily/<UTC>/… e, na 1ª execução bem-sucedida de cada mês, também
# monthly/<AAAA-MM>/<UTC>/…. Retenção e proteção contra apagamento NÃO são feitas
# aqui: são as regras de lifecycle e o bucket lock do R2 (o script nunca apaga
# nada no bucket). Um conjunto só está completo se tiver o manifest.json.age,
# que sobe por último.
#
# Credenciais: só no arquivo $BACKUP_ENV (padrão ~/.config/cemed-backup/backup.env,
# permissão 600). Modelo: scripts/backup/backup.env.example.
# Alerta: healthchecks.io — /start, sucesso com tamanhos, /fail com o log redigido.
# Mídia que não baixa não segura o banco: o conjunto sobe inteiro, o INDICE.json
# lista os objetos com erro e o /fail dispara assim mesmo (código 3).
#
#   scripts/backup/backup.sh
#
# Teste ponta a ponta (sem tocar em nada externo): scripts/backup/test-backup.sh
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=_lib.sh
. "$HERE/_lib.sh"

BACKUP_ENV="${BACKUP_ENV:-$HOME/.config/cemed-backup/backup.env}"
bk_load_env "$BACKUP_ENV"
bk_require SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY \
  R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET HC_PING_URL AGE_RECIPIENT
if [ -z "${R2_ENDPOINT:-}" ]; then
  bk_require R2_ACCOUNT_ID
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
fi
[[ $AGE_RECIPIENT =~ ^age1[a-z0-9]{58}$ ]] || bk_die "AGE_RECIPIENT não é uma chave pública age (age1…)"
MEDIA_BUCKETS="${BACKUP_MEDIA_BUCKETS:-whatsapp-media}"
[[ $MEDIA_BUCKETS =~ ^[a-z0-9._-]+(\ [a-z0-9._-]+)*$ ]] || bk_die "BACKUP_MEDIA_BUCKETS inválido"

# Uma execução por vez (cron × manual × update.sh). Quem chega depois sai sem
# alarme: a execução em andamento é quem pinga.
exec 9>"$(dirname "$BACKUP_ENV")/backup.lock"
flock -n 9 || { bk_log "outro backup em andamento; nada a fazer"; exit 0; }

WORK=$(mktemp -d "${BACKUP_TMPDIR:-${TMPDIR:-/tmp}}/cemed-backup.XXXXXX")
# Log síncrono num arquivo (o /fail leva o fim dele); a saída original recebe
# tudo no fim. Sem `tee`: com ele, a última linha às vezes não chega ao ping.
exec 3>&1 >>"$WORK/run.log" 2>&1

on_exit() {
  local rc=$?
  set +e
  [ -n "${SNAP_PID:-}" ] && kill "$SNAP_PID" 2>/dev/null
  if [ "$rc" -ne 0 ]; then
    bk_log "FALHOU (código $rc)"
    bk_hc "$HC_PING_URL" /fail "$(tail -n 40 "$WORK/run.log")"
  fi
  cat "$WORK/run.log" >&3
  rm -rf "$WORK"
}
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

T0=$(date +%s)
NOW="${BACKUP_NOW:-now}" # só o teste fixa a data
STAMP=$(date -u -d "$NOW" +%Y-%m-%dT%H%M%SZ)
MONTH=$(date -u -d "$NOW" +%Y-%m)
PREFIXES=("daily/$STAMP")

bk_hc "$HC_PING_URL" /start
bk_log "backup $STAMP (execução $BK_RID)"
bk_pg_env

# ── 1. Snapshot: contagens e lista de mídia na MESMA transação que o pg_dump ──
coproc SNAP { exec psql -qAtX -v ON_ERROR_STOP=1 2>&1; }

# snap_query SQL — manda uma consulta de uma linha e lê a resposta em $REPLY_LINE.
snap_query() {
  printf '%s\n' "$1" >&"${SNAP[1]}"
  IFS= read -r -t 600 REPLY_LINE <&"${SNAP[0]}" || bk_die "o psql do snapshot não respondeu"
}

snap_query "begin isolation level repeatable read read only; select pg_export_snapshot();"
[[ $REPLY_LINE =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || bk_die "snapshot não exportado: $REPLY_LINE"
SNAP_ID=$REPLY_LINE

SCHEMAS="'public','auth','storage'"
snap_query "select json_build_object(
  'taken_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),
  'server_version', current_setting('server_version'),
  'tables', (select json_object_agg(format('%I.%I', n.nspname, c.relname),
      (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from only %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
      order by n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and n.nspname in ($SCHEMAS)),
  'policies', (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname in ($SCHEMAS)),
  'acl_relations', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace,
    aclexplode(c.relacl) where n.nspname in ($SCHEMAS)),
  'acl_functions', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
    aclexplode(p.proacl) where n.nspname in ($SCHEMAS)));"
[[ $REPLY_LINE == '{'* ]] || bk_die "contagem falhou: $REPLY_LINE"
META=$REPLY_LINE

sep="','"
BUCKETS_SQL="array['${MEDIA_BUCKETS// /$sep}']"
snap_query "select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name,
    'size', (metadata->>'size')::bigint) order by bucket_id, name), '[]')
  from storage.objects where name is not null and bucket_id = any($BUCKETS_SQL);"
[[ $REPLY_LINE == '['* ]] || bk_die "lista de mídia falhou: $REPLY_LINE"
MEDIA_LIST=$REPLY_LINE

# ── 2. Banco e roles, cifrados no pipe (o texto claro nunca toca o disco) ──
bk_log "pg_dump public+auth+storage (snapshot $SNAP_ID)"
pg_dump --snapshot="$SNAP_ID" --format=custom --schema=public --schema=auth --schema=storage \
  | age -r "$AGE_RECIPIENT" -o "$WORK/db.dump.age"

snap_query "commit; select 'fim';"
printf '\\q\n' >&"${SNAP[1]}"
wait "$SNAP_PID" 2>/dev/null || true
SNAP_PID=

bk_log "pg_dumpall --roles-only"
pg_dumpall --roles-only --no-role-passwords | age -r "$AGE_RECIPIENT" -o "$WORK/roles.sql.age"

# ── 3. Mídia: tar em streaming direto para o age ──
bk_log "mídia ($MEDIA_BUCKETS)"
printf '%s' "$MEDIA_LIST" \
  | SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
    python3 -I "$HERE/media-tar.py" --summary "$WORK/media-summary.json" \
  | age -r "$AGE_RECIPIENT" -o "$WORK/media.tar.age"

# ── 4. Manifest (cifrado também: lista tabelas e nomes de arquivo) ──
FILES=(db.dump.age roles.sql.age media.tar.age)
files_json='{}'
for f in "${FILES[@]}"; do
  files_json=$(jq -c --arg f "$f" --argjson bytes "$(stat -c %s "$WORK/$f")" \
    --arg sha "$(sha256sum "$WORK/$f" | cut -d' ' -f1)" '.[$f] = {bytes: $bytes, sha256: $sha}' <<<"$files_json")
done
jq -n --argjson meta "$META" --slurpfile media "$WORK/media-summary.json" --argjson files "$files_json" \
  --arg stamp "$STAMP" --arg rid "$BK_RID" --arg pgdump "$(pg_dump --version)" \
  --arg commit "$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo desconhecido)" \
  --arg buckets "$MEDIA_BUCKETS" \
  '{formato: 1, stamp: $stamp, execucao: $rid, commit: $commit, pg_dump: $pgdump,
    banco: $meta, midia: ($media[0] + {buckets: ($buckets | split(" "))}), arquivos: $files}' \
  | age -r "$AGE_RECIPIENT" -o "$WORK/manifest.json.age"
FILES+=(manifest.json.age)

# ── 5. Upload (manifest por último) ──
if ! bk_s3_keys "monthly/$MONTH/" | grep -q '/manifest\.json\.age$'; then
  PREFIXES+=("monthly/$MONTH/$STAMP")
fi
for p in "${PREFIXES[@]}"; do
  for f in "${FILES[@]}"; do
    bk_s3_put "$p/$f" "$WORK/$f"
  done
  bk_log "enviado: $p/"
done

# ── 6. Sucesso ──
human() { numfmt --to=iec --suffix=B "$1"; }
tables=$(jq '.tables | length' <<<"$META")
rows=$(jq '[.tables[]] | add // 0' <<<"$META")
media=$(cat "$WORK/media-summary.json")
summary="enviado ${PREFIXES[*]}
db=$(human "$(stat -c %s "$WORK/db.dump.age")") roles=$(human "$(stat -c %s "$WORK/roles.sql.age")") midia=$(human "$(stat -c %s "$WORK/media.tar.age")")
tabelas=$tables linhas=$rows policies=$(jq .policies <<<"$META") grants=$(jq '.acl_relations + .acl_functions' <<<"$META")
midia_objetos=$(jq .objetos <<<"$media") midia_ausentes=$(jq .ausentes <<<"$media") midia_erros=$(jq .erros <<<"$media")
duracao=$(($(date +%s) - T0))s"
bk_log "$summary"
# Banco e mídia já estão no R2; se algum objeto de mídia não baixou, o alerta
# dispara mesmo assim (o on_exit manda /fail com este log).
if [ "$(jq .erros <<<"$media")" -gt 0 ]; then
  bk_log "ATENÇÃO: $(jq .erros <<<"$media") objeto(s) de mídia não copiado(s) — lista em INDICE.json (erros) do media.tar"
  exit 3
fi
bk_hc "$HC_PING_URL" "" "$summary"
