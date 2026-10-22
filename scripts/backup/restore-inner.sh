#!/usr/bin/env bash
# Metade do restore-test.sh que roda DENTRO do contêiner descartável
# (restore.Dockerfile): sem rede, Postgres e dados decifrados em tmpfs (RAM).
#
#   stdin  a chave privada age, uma linha (fica só em memória)
#   /in    os 4 cifrados do conjunto, só leitura
#   /bk    scripts/backup, só leitura
#
# Sai 0 se o banco restaurado bate com o manifest (contagem exata de cada tabela,
# policies, tabelas com RLS, grants) e a mídia confere arquivo a arquivo.
set -euo pipefail
# shellcheck source=_lib.sh
. /bk/_lib.sh

IN=/in
R=/restore
export PGDATA=/var/lib/postgresql/data
PGSOCK=/var/run/postgresql
DIVERGE=0
diverge() { bk_log "DIVERGÊNCIA: $*"; DIVERGE=$((DIVERGE + 1)); }

IFS= read -r KEY || true

# ── 1. Integridade (sha256 × manifest) e decifragem para o tmpfs ──
bk_decrypt_set "$IN" "$R"
unset KEY

# ── 2. Postgres efêmero, só por socket ──
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"
gosu postgres initdb -U restore_admin --auth=trust -D "$PGDATA" >/dev/null
gosu postgres pg_ctl -D "$PGDATA" -l /tmp/pg.log -w \
  -o "-c listen_addresses='' -c unix_socket_directories=$PGSOCK" start >/dev/null
q() { psql -h "$PGSOCK" -U restore_admin -d postgres -X -q "$@"; }

# ── 3. Pré-requisitos fora dos schemas do dump ──
# Roles do Supabase (sem senha). Parte do arquivo não se aplica a um Postgres cru
# (ALTER ROLE de atributos/parâmetros de lá): esses erros são tolerados e listados.
# O superusuário daqui é restore_admin, então o `ALTER ROLE postgres NOSUPERUSER`
# do Supabase não tira o poder de quem restaura. O `GRANTED BY supabase_admin` das
# filiações sai: aqui quem concede é o superusuário que restaura.
sed -E 's/ GRANTED BY [^;]+;/;/' "$R/roles.sql" | q >"$R/roles.log" 2>&1 || true
bk_log "roles: $(grep -c '^CREATE ROLE' "$R/roles.sql" || true) no arquivo, $(grep -c 'ERROR' "$R/roles.log" || true) erro(s) tolerado(s)"
grep 'ERROR' "$R/roles.log" | sed -E 's/^.*ERROR: +//' | sort | uniq -c | head -15 | sed 's/^/    /' || true

# Restore em duas passadas pelo TOC: primeiro os schemas (com os donos da
# produção), depois as extensões que a produção tinha (pg_dump com --schema não
# as recria; os tipos delas, como vector, são usados pelas tabelas), e então todo
# o resto. O `CREATE SCHEMA public` do dump NÃO roda: o pg_dump escreve os grants
# de public relativos ao public padrão de um banco novo (recriá-lo perde o USAGE
# de PUBLIC — o teste pegou). O public padrão fica e só recebe o dono do dump.
restore_toc() {
  if ! pg_restore -h "$PGSOCK" -U restore_admin -d postgres --exit-on-error -L "$1" "$R/db.dump" >>"$R/restore.log" 2>&1; then
    sed 's/^/    /' "$R/restore.log" | tail -n 15
    bk_die "pg_restore falhou ($2)"
  fi
}
SCHEMA_RE='^[0-9]+; [0-9]+ [0-9]+ SCHEMA - '
pg_restore -l "$R/db.dump" >"$R/toc.all"
grep -E "$SCHEMA_RE" "$R/toc.all" | grep -v ' SCHEMA - public ' >"$R/toc.schemas" || true
grep -vE "$SCHEMA_RE" "$R/toc.all" >"$R/toc.rest"
public_owner=$(grep -E "$SCHEMA_RE"'public ' "$R/toc.all" | awk '{print $NF}' || true)
[ -z "$public_owner" ] || q -c "alter schema public owner to \"$public_owner\""

# ── 4. Restore COM donos e grants ──
bk_log "pg_restore: schemas"
restore_toc "$R/toc.schemas" schemas

while IFS=$'\t' read -r ext sch; do
  case $sch in
    pg_catalog | information_schema) continue ;; # plpgsql e afins já vêm com o Postgres
  esac
  q -c "create schema if not exists \"$sch\"" >/dev/null 2>&1 || true
  q -c "create extension if not exists \"$ext\" with schema \"$sch\"" >/dev/null 2>&1 \
    || bk_log "extensão $ext indisponível aqui (ok se o dump não depender dela)"
done < <(jq -r '.banco.extensions // [] | .[] | [.name, .schema] | @tsv' "$R/manifest.json")

bk_log "pg_restore: o resto (com donos e grants, para no 1º erro)"
restore_toc "$R/toc.rest" "tabelas, dados, funções, policies e grants"
bk_restore_publications

# ── 5. Banco restaurado × manifest ──
q -At -c "$(bk_stats_sql)" >"$R/got.json"
jq -r -n --slurpfile want "$R/manifest.json" --slurpfile got "$R/got.json" '
  ($want[0].banco) as $w | ($got[0]) as $g
  | (([$w.tables | keys[]] + [$g.tables | keys[]]) | unique[]
      | select($w.tables[.] != $g.tables[.])
      | "tabela \(.): backup=\($w.tables[.] // "ausente") restaurado=\($g.tables[.] // "ausente")"),
    (["policies", "rls_tables", "acl_relations", "acl_functions"][]
      | select($w[.] != null and $w[.] != $g[.])
      | "\(.): backup=\($w[.]) restaurado=\($g[.])"),
    (($w.acl // []) - $g.acl | .[:30][] | "grant só no backup (perdido no restore): \(.)"),
    (($w.publications // []) - $g.publications | .[] | "publicação perdida: \(.)"),
    ($g.publications - ($w.publications // $g.publications) | .[] | "publicação a mais: \(.)"),
    ($g.acl - ($w.acl // $g.acl) | .[:30][] | "grant só no restaurado (não existia no backup): \(.)")
' >"$R/diff.txt"
while IFS= read -r line; do diverge "$line"; done <"$R/diff.txt"
tables=$(jq '.tables | length' "$R/got.json")
rows=$(jq '[.tables[]] | add // 0' "$R/got.json")

# ── 6. Mídia: sha256 de cada arquivo + cobertura das linhas de storage.objects ──
idx="$R/media/INDICE.json"
[ -f "$idx" ] || bk_die "media.tar sem INDICE.json"
jq -r '.objetos[] | "\(.sha256)  \(.bucket)/\(.name)"' "$idx" >"$R/media.sha256"
if ! (cd "$R/media" && sha256sum --quiet -c "$R/media.sha256") >"$R/media.check" 2>&1; then
  while IFS= read -r line; do diverge "mídia: $line"; done <"$R/media.check"
fi
buckets=$(jq -r '.midia.buckets | map("'"'"'" + . + "'"'"'") | join(",")' "$R/manifest.json")
q -At -c "select bucket_id || '/' || name from storage.objects
          where name is not null and bucket_id in ($buckets) order by 1" >"$R/rows.txt"
jq -r '(.objetos + .ausentes + .erros)[] | "\(.bucket)/\(.name)"' "$idx" | sort >"$R/indexed.txt"
sort -o "$R/rows.txt" "$R/rows.txt"
comm -3 "$R/rows.txt" "$R/indexed.txt" | sed 's/^\t/    só no índice: /; t; s/^/    só no banco: /' >"$R/cover.txt"
[ ! -s "$R/cover.txt" ] || { diverge "mídia: linhas de storage.objects e índice do tar não batem"; cat "$R/cover.txt"; }
n_obj=$(jq '.objetos | length' "$idx")
n_aus=$(jq '.ausentes | length' "$idx")
n_err=$(jq '.erros | length' "$idx")
[ "$n_err" = 0 ] || bk_log "aviso: $n_err objeto(s) já tinham falhado no backup (o alerta disparou naquele dia)"

echo "RESUMO conjunto=$(jq -r .stamp "$R/manifest.json") tabelas=$tables linhas=$rows policies=$(jq .policies "$R/got.json") rls=$(jq .rls_tables "$R/got.json") grants=$(jq '.acl_relations + .acl_functions' "$R/got.json") midia=$n_obj ausentes=$n_aus erros_no_backup=$n_err divergencias=$DIVERGE"
[ "$DIVERGE" = 0 ]
