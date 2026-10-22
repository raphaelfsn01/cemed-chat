#!/usr/bin/env bash
# Metade do restore-supabase.sh que roda DENTRO do contêiner descartável
# (restore.Dockerfile). Dados decifrados só em /restore (tmpfs).
#
#   stdin  linha 1: chave privada age; depois TARGET_*=valor
#   /in    os 4 cifrados do conjunto, só leitura
#   /bk    scripts/backup, só leitura
set -euo pipefail
# shellcheck source=_lib.sh
. /bk/_lib.sh

IN=/in
R=/restore
IFS= read -r KEY || true
while IFS= read -r line; do
  case ${line%%=*} in
    TARGET_DB_URL | TARGET_SUPABASE_URL | TARGET_SERVICE_ROLE_KEY) printf -v "${line%%=*}" '%s' "${line#*=}" ;;
  esac
done

bk_decrypt_set "$IN" "$R"
unset KEY
bk_pg_env "$TARGET_DB_URL"
q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
TOC_RE='^[0-9]+; [0-9]+ [0-9]+ '

# ── 0. O destino precisa ser um projeto novo, vazio ──
n_pub=$(q -At -c "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')")
n_users=$(q -At -c "select count(*) from auth.users")
if [ "$n_pub" != 0 ] || [ "$n_users" != 0 ]; then
  bk_die "o destino não está vazio (public: $n_pub tabela(s), auth.users: $n_users) — use um projeto Supabase NOVO"
fi

# ── 1. Extensões que a produção tinha ──
while IFS=$'\t' read -r ext sch; do
  case $sch in pg_catalog | information_schema) continue ;; esac
  q -c "create schema if not exists \"$sch\"" >/dev/null 2>&1 || true
  q -c "create extension if not exists \"$ext\" with schema \"$sch\"" >/dev/null 2>&1 \
    || bk_log "aviso: extensão $ext não pôde ser criada em $sch (habilite no painel se o restore reclamar)"
done < <(jq -r '.banco.extensions // [] | .[] | [.name, .schema] | @tsv' "$R/manifest.json")

# ── 2. Escolha das entradas do dump ──
# auth e storage: só DADOS (o schema é gerenciado pelo Supabase), menos as tabelas
# de controle de migração, que o projeto novo já tem preenchidas.
# Só tabelas que TINHAM linhas no backup: as vazias ficam como o projeto novo as
# criou (algumas internas do Storage nem aceitam COPY do postgres, mesmo vazio).
pg_restore -l "$R/db.dump" >"$R/toc.all"
jq -r '.banco.tables | to_entries[] | select(.value > 0) | .key' "$R/manifest.json" >"$R/nonempty.txt"
data_toc() {
  awk -v sch="$1" 'NR == FNR { keep[$0] = 1; next }
    $6 == sch && $4 " " $5 == "TABLE DATA" && (($6 "." $7) in keep) \
      && $7 != "schema_migrations" && $7 != "migrations" { print; next }
    $6 == sch && $4 " " $5 == "SEQUENCE SET" { print }' "$R/nonempty.txt" "$R/toc.all"
}
data_toc auth >"$R/toc.auth"
data_toc storage >"$R/toc.storage"
# Policies em storage.objects são NOSSAS (baseline): o projeto novo não as tem.
grep -E "${TOC_RE}POLICY storage " "$R/toc.all" >"$R/toc.storage-policies" || true

# Dados com triggers e FKs desligados durante a carga (receita do Supabase).
load_data() {
  { echo "set session_replication_role = replica;"; pg_restore -f - -L "$1" "$R/db.dump"; } \
    | q --single-transaction -f - >/dev/null
}

bk_log "auth: dados de $(grep -c 'TABLE DATA' "$R/toc.auth" || true) tabela(s)"
load_data "$R/toc.auth"

# public inteiro, menos os default privileges de roles internos do Supabase
# (supabase_admin…): o projeto novo já os tem e o postgres não pode alterá-los.
me=$(q -At -c 'select current_user')

# O projeto novo dá ALL a anon/authenticated/service_role em toda tabela/função
# que o postgres cria em public (default privileges). O pg_dump escreve os grants
# como diferença do padrão do Postgres — então, sem isto, todo REVOKE da produção
# (tabelas e as security definer fechadas para anon) voltaria aberto. Os defaults
# de produção voltam no fim, pelas entradas DEFAULT ACL do próprio dump.
q -At -c "select format('alter default privileges for role %I in schema public revoke all on %s from %s;',
            pg_get_userbyid(d.defaclrole),
            case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
                                 when 'f' then 'functions' when 'T' then 'types' end,
            case a.grantee when 0 then 'public' else quote_ident(pg_get_userbyid(a.grantee)) end)
          from pg_default_acl d, aclexplode(d.defaclacl) a
          where d.defaclrole = (select oid from pg_roles where rolname = current_user)
            and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype in ('r','S','f','T')" \
  | q -f - >/dev/null
pg_restore -l --schema=public "$R/db.dump" >"$R/toc.public.all"
awk -v me="$me" '!($0 ~ / DEFAULT ACL / && $NF != me)' "$R/toc.public.all" >"$R/toc.public"
bk_log "public: schema completo, dados, policies e grants ($(($(grep -c ' DEFAULT ACL ' "$R/toc.public.all" || true) - $(grep -c ' DEFAULT ACL ' "$R/toc.public" || true))) default privilege(s) de role interno já presentes no projeto novo)"
pg_restore -d "$PGDATABASE" --exit-on-error --single-transaction -L "$R/toc.public" "$R/db.dump"

bk_log "storage: dados e $(wc -l <"$R/toc.storage-policies") policy(ies) nossa(s)"
load_data "$R/toc.storage"
[ ! -s "$R/toc.storage-policies" ] \
  || pg_restore -d "$PGDATABASE" --exit-on-error --single-transaction -L "$R/toc.storage-policies" "$R/db.dump"
bk_restore_publications
bk_log "realtime: $(jq '.banco.publications // [] | length' "$R/manifest.json") tabela(s) recolocada(s) nas publicações"

# ── 3. Mídia: reenvio pela Storage API, no mesmo caminho, com o mimetype da linha ──
buckets=$(jq -r '.midia.buckets | map("'"'"'" + . + "'"'"'") | join(",")' "$R/manifest.json")
q -At -F $'\t' -c "select bucket_id, name, coalesce(metadata->>'mimetype', 'application/octet-stream')
  from storage.objects where name is not null and bucket_id in ($buckets) order by 1, 2" >"$R/objs.tsv"
auth_cfg() {
  printf 'header = %s\n' "$(bk_curl_quote "Authorization: Bearer $TARGET_SERVICE_ROLE_KEY")"
  printf 'header = %s\n' "$(bk_curl_quote "apikey: $TARGET_SERVICE_ROLE_KEY")"
}
sent=0 missing=0 failed=0
while IFS=$'\t' read -r bucket name mime; do
  f="$R/media/$bucket/$name"
  if [ ! -f "$f" ]; then missing=$((missing + 1)); continue; fi
  path=$(python3 -I -c 'import sys, urllib.parse as u; print(u.quote(sys.argv[1], safe="/"))' "$name")
  if curl -fsS -m 300 --retry 3 -o /dev/null -K <(auth_cfg) -H "x-upsert: true" -H "Content-Type: $mime" \
    --data-binary @"$f" "${TARGET_SUPABASE_URL%/}/storage/v1/object/$bucket/$path"; then
    sent=$((sent + 1))
  else
    failed=$((failed + 1))
    bk_log "falhou o envio de $bucket/$name"
  fi
done <"$R/objs.tsv"
bk_log "mídia: $sent enviado(s), $missing sem arquivo no backup, $failed falha(s)"

# ── 4. Conferência com o manifest ──
q -At -c "$(bk_stats_sql)" >"$R/got.json"
jq -r -n --slurpfile want "$R/manifest.json" --slurpfile got "$R/got.json" '
  ($want[0].banco) as $w | ($got[0]) as $g
  | (([$w.tables | keys[]] + [$g.tables | keys[]]) | unique[]
      | select(. != "auth.schema_migrations" and . != "storage.migrations")
      | select($w.tables[.] != $g.tables[.])
      | "tabela \(.): backup=\($w.tables[.] // "ausente") restaurado=\($g.tables[.] // "ausente")"),
    ([$w.acl[] | select(test($scope))] - $g.acl | .[:30][] | "grant perdido: \(.)"),
    ([$g.acl[] | select(test($scope))] - $w.acl | .[:30][] | "grant a mais: \(.)"),
    (($w.publications // []) - $g.publications | .[] | "publicação perdida: \(.)"),
    ($g.publications - ($w.publications // $g.publications) | .[] | "publicação a mais: \(.)")
' --arg scope "^(rel|fn) public\\.|^default $me/public/" >"$R/diff.txt"
if [ -s "$R/diff.txt" ] || [ "$failed" != 0 ]; then
  sed 's/^/  DIVERGÊNCIA: /' "$R/diff.txt"
  bk_die "restauração carregada, mas com divergências (acima). Revise antes de apontar o app para este projeto."
fi
cat <<EOF

RESTAURAÇÃO CONCLUÍDA — $(jq '.tables | length' "$R/got.json") tabelas, $(jq '[.tables[]] | add // 0' "$R/got.json") linhas, mídia $sent arquivo(s); tudo bate com o manifest.
Próximos passos (runbook, seção "Desastre"): trocar no .env da VPS a URL, as chaves e o
SUPABASE_DB_URL pelos do projeto novo, subir o app e o worker, e entrar com um usuário
real (as senhas vieram; as sessões antigas não valem no projeto novo).
EOF
