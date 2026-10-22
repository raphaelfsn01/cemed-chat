#!/usr/bin/env bash
# SC2016: os trechos entre aspas simples são expandidos DENTRO do contêiner, de propósito.
# shellcheck disable=SC2016
# Prova ponta a ponta do backup.sh e do restore-test.sh SEM tocar em nada externo
# nem na produção.
#
# Numa rede Docker isolada sobe:
#   origem   supabase/postgres 17 (o Postgres do Supabase, com os roles reais:
#            supabase_auth_admin, supabase_storage_admin, postgres não-superusuário),
#            com tabela RLS + grants + função revogada + um e-mail "canário"
#   R2       versitygw (gateway S3 com SigV4 de verdade; payload e assinatura conferidos)
#   stubs    Storage do Supabase (mídia) e healthchecks.io (registra os pings)
# e roda o backup.sh dentro do mesmo Ubuntu da VPS (test/runner.Dockerfile).
#
# Backup: caminho feliz (inclui o mensal do dia 1), 2ª execução no mês, e as
# sabotagens: senha do banco errada, chave do Storage errada, objeto 500, R2 fora
# do ar, backup.env 644, chave age inválida, execução concorrente.
# Restauração (restore-test.sh roda no HOST, como na VPS; o R2 e o healthchecks
# ficam expostos só em 127.0.0.1): restaura diário e mensal, e as sabotagens
# contagem/grant/RLS adulterados no manifest, cifrado corrompido, mídia trocada,
# chave errada e entrada que não é chave.
#
#   bash scripts/backup/test-backup.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER=cemed-backup-runner:test
SRC_IMAGE="${SRC_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}"
S3_IMAGE=versity/versitygw:v1.8.0
ID="cemed-bk-test-$$"
NET=$ID
UGID="$(id -u):$(id -g)"
CANARIO=canario-backup@exemplo.test

avail=$(free -m | awk '/^Mem:/{print $7}')
[ "$avail" -ge 1500 ] || { echo "FATAL: só ${avail} MB livres (mínimo 1500) — máquina compartilhada com a produção" >&2; exit 1; }

T=$(mktemp -d "${TMPDIR:-/tmp}/cemed-backup-test.XXXXXX")
chmod 700 "$T"
cleanup() {
  docker rm -f "$ID-src" "$ID-s3" "$ID-stubs" >/dev/null 2>&1 || true
  docker ps -aq --filter name=cemed-restore- | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT

FAILS=0
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
ko() { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAILS=$((FAILS + 1)); }
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else ko "$d"; fi; }
step() { printf '\n==> %s\n' "$*"; }

runner() {
  docker run --rm --network "$NET" --user "$UGID" -e HOME=/tmp \
    -v "$HERE:/bk:ro" -v "$T:/t" "$@"
}
# Roda um comando bash no runner com o _lib carregado e o backup.env do teste lido.
in_lib() { runner "$RUNNER" bash -c ". /bk/_lib.sh; bk_load_env /t/cfg/backup.env; $1"; }

# run_backup DIR_CFG BACKUP_NOW — devolve o código de saída em $RC, a saída em $T/out.log
run_backup() {
  set +e
  runner -e BACKUP_ENV="/t/$1/backup.env" -e BACKUP_TMPDIR=/t/tmp -e BACKUP_NOW="$2" \
    "$RUNNER" /bk/backup.sh >"$T/out.log" 2>&1
  RC=$?
  set -e
}
hc_lines() { wc -l <"$T/hc/hc.log"; }
keys() { in_lib "bk_s3_keys '$1'"; }

# write_env DIR [CHAVE=valor ...] — backup.env 600 do teste, com sobrescritas.
write_env() {
  local dir="$T/$1"; shift
  mkdir -p "$dir"; chmod 700 "$dir"
  {
    echo "SUPABASE_DB_URL=postgresql://postgres:senha-src-teste@$ID-src:5432/postgres?sslmode=disable"
    echo "SUPABASE_URL=http://$ID-stubs:8000"
    echo "SUPABASE_SERVICE_ROLE_KEY=chave-service-teste"
    echo "R2_ACCESS_KEY_ID=testkey"
    echo "R2_SECRET_ACCESS_KEY=segredo-s3-teste"
    echo "R2_BUCKET=cemed-backups-teste"
    echo "R2_ENDPOINT=http://$ID-s3:7070"
    echo "HC_PING_URL=http://$ID-stubs:8000/hc/diario"
    echo "AGE_RECIPIENT=$(cat "$T/key.pub")"
    printf '%s\n' "$@"
  } >"$dir/backup.env.tmp"
  # Sobrescritas: a última ocorrência da chave vale — remonta sem duplicatas.
  tac "$dir/backup.env.tmp" | awk -F= '!seen[$1]++' | tac >"$dir/backup.env"
  rm -f "$dir/backup.env.tmp"
  chmod 600 "$dir/backup.env"
}

step "imagens e rede"
docker build -q -t "$RUNNER" -f "$HERE/test/runner.Dockerfile" "$HERE/test" >/dev/null
docker network create "$NET" >/dev/null

mkdir -p "$T/tmp" "$T/hc" "$T/out" "$T/media/whatsapp-media/org1/conv1" "$T/media/skill-assets"
: >"$T/hc/hc.log"
head -c 200000 /dev/urandom >"$T/media/whatsapp-media/org1/conv1/msg1.jpg"
: >"$T/media/whatsapp-media/org1/conv1/vazio.bin"
printf 'áudio de teste' >"$T/media/whatsapp-media/org1/conv1/ação-ç.ogg"
echo fora-do-escopo >"$T/media/skill-assets/fora.txt"

docker run -d --name "$ID-s3" --network "$NET" -p 127.0.0.1::7070 "$S3_IMAGE" \
  --access testkey --secret segredo-s3-teste --region auto posix /tmp >/dev/null
docker run -d --name "$ID-src" --network "$NET" -e POSTGRES_PASSWORD=senha-src-teste "$SRC_IMAGE" >/dev/null
docker run -d --name "$ID-stubs" --network "$NET" -p 127.0.0.1::8000 --user "$UGID" \
  -e STUB_KEY=chave-service-teste -e MEDIA_DIR=/media -e HC_LOG=/hc/hc.log \
  -v "$T/media:/media:ro" -v "$T/hc:/hc" -v "$HERE/test/stubs.py:/stubs.py:ro" \
  "$RUNNER" python3 -I /stubs.py >/dev/null

runner "$RUNNER" age-keygen -o /t/key 2>/dev/null
grep -o 'age1[a-z0-9]*' "$T/key" >"$T/key.pub"

src_sql() { docker exec -i -e PGPASSWORD=senha-src-teste "$ID-src" psql -h 127.0.0.1 -v ON_ERROR_STOP=1 -qAt -d postgres -U "$1"; }
ready=0
for _ in $(seq 1 90); do
  if echo "select 1 from auth.users limit 1" | src_sql postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || { echo "FATAL: origem não ficou pronta" >&2; exit 1; }

step "origem: donos como na produção, RLS, grants e canário"
src_sql supabase_admin <<SQL
-- A imagem crua não traz as tabelas do Storage (quem cria é a API do Storage):
-- o formato mínimo das reais, com o dono real.
create table if not exists storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false,
  created_at timestamptz default now());
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now());
grant usage on schema storage to postgres;
grant select on all tables in schema storage to postgres;
do \$\$ declare r record; begin
  for r in select c.oid::regclass as t, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('auth','storage') and c.relkind = 'r' loop
    execute format('alter table %s owner to %I', r.t,
      case r.nspname when 'auth' then 'supabase_auth_admin' else 'supabase_storage_admin' end);
  end loop;
end \$\$;
-- Como na produção: vector em public (o restore recria pelo manifest).
create extension if not exists vector with schema public;
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', '$CANARIO');
insert into storage.buckets (id, name, public) values ('whatsapp-media','whatsapp-media',false), ('skill-assets','skill-assets',false);
insert into storage.objects (bucket_id, name, metadata) values
  ('whatsapp-media', 'org1/conv1/msg1.jpg', '{"size":200000}'),
  ('whatsapp-media', 'org1/conv1/vazio.bin', '{"size":0}'),
  ('whatsapp-media', 'org1/conv1/ação-ç.ogg', '{"size":15}'),
  ('whatsapp-media', 'org1/conv1/sumiu.jpg', '{"size":10}'),
  ('skill-assets', 'fora.txt', '{"size":15}');
SQL
# Volume de produção: a lista de grants do manifest passa de 128 KiB (o limite do
# Linux para um argumento), como na VPS — o primeiro backup real quebrou aí.
src_sql postgres <<SQL
do \$\$ begin
  for i in 1..150 loop
    execute format('create table public.volume_%s (id int)', i);
    execute format('grant all on public.volume_%s to anon, authenticated, service_role', i);
  end loop;
end \$\$;
SQL
src_sql postgres <<SQL
create table public.pacientes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  nome text,
  email text,
  user_id uuid references auth.users(id),
  embedding public.vector(3) default '[1,2,3]');
alter table public.pacientes enable row level security;
create policy tenant_isolation_pacientes_all on public.pacientes for all to authenticated
  using (user_id = auth.uid());
revoke all on public.pacientes from anon;
grant select, insert on public.pacientes to authenticated;
grant all on public.pacientes to service_role;
create function public.fn_teste() returns int language sql security definer as 'select 1';
revoke execute on function public.fn_teste() from public, anon;
grant execute on function public.fn_teste() to authenticated;
insert into public.pacientes (organization_id, nome, email, user_id)
  select gen_random_uuid(), 'Paciente ' || g, 'p' || g || '@exemplo.test', null from generate_series(1, 249) g;
insert into public.pacientes (organization_id, nome, email, user_id)
  values (gen_random_uuid(), 'Canário', '$CANARIO', '11111111-1111-1111-1111-111111111111');
SQL
# Como na produção: tabela na publicação do Realtime (o pg_dump com --schema não a exporta).
src_sql supabase_admin <<SQL
do \$\$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end \$\$;
alter publication supabase_realtime add table public.pacientes;
SQL

write_env cfg
in_lib 'curl -fsS -K <(bk_s3_cfg) -H "x-amz-content-sha256: $BK_EMPTY_SHA256" -X PUT "$R2_ENDPOINT/$R2_BUCKET" -o /dev/null'

# ───────────────────────────────────────────────────────────────────────────
step "1. caminho feliz no dia 1 do mês (diário + mensal)"
h0=$(hc_lines)
run_backup cfg 2026-11-01T08:15:00Z
check "backup.sh saiu com 0" test "$RC" = 0
[ "$RC" = 0 ] || sed 's/^/     | /' "$T/out.log"
D=daily/2026-11-01T081500Z
M=monthly/2026-11/2026-11-01T081500Z
keys "$D/" >"$T/k-daily"
keys "monthly/2026-11/" >"$T/k-monthly"
check "4 arquivos no diário" test "$(wc -l <"$T/k-daily")" = 4
check "4 arquivos no mensal" test "$(wc -l <"$T/k-monthly")" = 4
for f in db.dump.age roles.sql.age media.tar.age manifest.json.age; do
  check "existe $D/$f" grep -qx "$D/$f" "$T/k-daily"
  check "existe $M/$f" grep -qx "$M/$f" "$T/k-monthly"
done
check "healthchecks: /start e sucesso, sem /fail" \
  bash -c "tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r .path | tr '\n' ' ' | grep -qx '/hc/diario/start /hc/diario '"
check "start e sucesso com o mesmo rid" \
  test "$(tail -n +$((h0 + 1)) "$T/hc/hc.log" | jq -r .query | sort -u | wc -l)" = 1
check "corpo do sucesso traz tamanhos e contagens" \
  bash -c "tail -n 1 '$T/hc/hc.log' | jq -r .body | grep -q 'midia_objetos=3 midia_ausentes=1'"
check "diretório temporário vazio depois do run" test -z "$(ls -A "$T/tmp")"

for f in db.dump.age roles.sql.age media.tar.age manifest.json.age; do
  in_lib "bk_s3_get '$D/$f' '/t/out/$f'"
done
# O dump custom já sai comprimido: procurar o canário nos bytes não prova cifra.
# A prova é o cabeçalho do age em todo arquivo que chegou ao R2.
for f in db.dump.age roles.sql.age media.tar.age manifest.json.age; do
  check "$f no R2 é um arquivo age (cifrado)" test "$(head -c 21 "$T/out/$f")" = "age-encryption.org/v1"
done

check "os 4 arquivos decifram com a chave age (e o dump/tar abrem)" runner -w /t/out "$RUNNER" bash -c '
  set -e
  for f in db.dump roles.sql media.tar manifest.json; do age -d -i /t/key -o "$f" "$f.age"; done
  pg_restore -l db.dump > toc.txt
  pg_restore -f - db.dump > dump.sql
  mkdir media && tar -xf media.tar -C media'
check "o dump decifrado tem o dado de verdade (canário)" grep -q "$CANARIO" "$T/out/dump.sql"
check "dump tem os schemas auth e storage" bash -c "grep -q 'SCHEMA - auth' '$T/out/toc.txt' && grep -q 'SCHEMA - storage' '$T/out/toc.txt'"
check "dump tem os dados de auth.users" grep -q 'TABLE DATA auth users' "$T/out/toc.txt"
check "dump tem a policy RLS" grep -q 'POLICY public pacientes tenant_isolation_pacientes_all' "$T/out/toc.txt"
check "dump tem os GRANTs da tabela (sem --no-privileges)" grep -q 'ACL public TABLE pacientes' "$T/out/toc.txt"
check "dump tem o REVOKE/GRANT da função" grep -q 'ACL public FUNCTION fn_teste' "$T/out/toc.txt"
check "dump mantém o dono supabase_auth_admin" grep -q 'OWNER TO supabase_auth_admin' "$T/out/dump.sql"
check "roles.sql cria supabase_auth_admin" grep -q 'CREATE ROLE supabase_auth_admin' "$T/out/roles.sql"
check "roles.sql sem senha" bash -c "! grep -qi 'PASSWORD ' '$T/out/roles.sql'"
check "manifest: lista de grants maior que 128 KiB (volume de produção)" \
  test "$(jq -c .banco.acl "$T/out/manifest.json" | wc -c)" -gt 131072
check "manifest: 250 linhas em public.pacientes" test "$(jq '.banco.tables["public.pacientes"]' "$T/out/manifest.json")" = 250
check "manifest: 1 linha em auth.users" test "$(jq '.banco.tables["auth.users"]' "$T/out/manifest.json")" = 1
check "manifest: policies e grants contados" test "$(jq '.banco.policies >= 1 and .banco.acl_relations > 0 and .banco.acl_functions > 0' "$T/out/manifest.json")" = true
for f in db.dump.age roles.sql.age media.tar.age; do
  check "manifest: sha256 de $f confere com o que está no R2" \
    test "$(jq -r --arg f "$f" '.arquivos[$f].sha256' "$T/out/manifest.json")" = "$(sha256sum "$T/out/$f" | cut -d' ' -f1)"
done
check "mídia: msg1.jpg idêntico ao original" cmp "$T/media/whatsapp-media/org1/conv1/msg1.jpg" "$T/out/media/whatsapp-media/org1/conv1/msg1.jpg"
check "mídia: arquivo de 0 byte presente" test -f "$T/out/media/whatsapp-media/org1/conv1/vazio.bin"
check "mídia: nome UTF-8 preservado" cmp "$T/media/whatsapp-media/org1/conv1/ação-ç.ogg" "$T/out/media/whatsapp-media/org1/conv1/ação-ç.ogg"
check "mídia: bucket fora do escopo não entrou" test ! -e "$T/out/media/skill-assets"
check "mídia: índice lista o ausente (linha sem arquivo)" test "$(jq -r '.ausentes[0].name' "$T/out/media/INDICE.json")" = org1/conv1/sumiu.jpg
check "mídia: sha256 do índice confere" test "$(jq -r '.objetos[] | select(.name=="org1/conv1/msg1.jpg") | .sha256' "$T/out/media/INDICE.json")" = "$(sha256sum "$T/media/whatsapp-media/org1/conv1/msg1.jpg" | cut -d' ' -f1)"

step "1b. redação: credencial conhecida nunca sai num ping"
red=$(in_lib 'bk_redact "a segredo-s3-teste b chave-service-teste c postgresql://u:p@h/db d"')
check "bk_redact troca segredo, chave e URL do banco" test "$red" = "a <redigido> b <redigido> c <url-redigida> d"
red=$(runner "$RUNNER" bash -c '. /bk/_lib.sh; R2_ACCESS_KEY_ID=k; bk_redact "backup ok"')
check "bk_redact não mutila o texto com valor curto" test "$red" = "backup ok"

step "2. segunda execução no mesmo mês: diário sim, mensal não"
run_backup cfg 2026-11-01T09:00:00Z
check "saiu com 0" test "$RC" = 0
check "mensal continua com 4 arquivos" test "$(keys monthly/2026-11/ | wc -l)" = 4
check "diário ganhou o 2º conjunto" test "$(keys daily/2026-11-01T090000Z/ | wc -l)" = 4

# sabotage NOME DATA MOTIVO_REGEX [CHAVE=valor ...] — exige falha, /fail com o motivo
# real no corpo, nada enviado, nada vazado.
sabotage() {
  local name=$1 stamp=$2 reason=$3; shift 3
  write_env "cfg-$name" "$@"
  local h0; h0=$(hc_lines)
  run_backup "cfg-$name" "$stamp"
  local day
  day="daily/$(date -u -d "$stamp" +%Y-%m-%dT%H%M%SZ)/"
  check "falhou (código ≠ 0)" test "$RC" != 0
  check "healthchecks recebeu /fail" bash -c "tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r .path | grep -qx '/hc/diario/fail'"
  check "nenhum arquivo enviado" test -z "$(keys "$day")"
  check "o /fail traz o motivo ($reason)" bash -c "tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r 'select(.path==\"/hc/diario/fail\") | .body' | grep -qE '$reason'"
  check "o /fail não vaza senha nem chave" bash -c "! tail -n +$((h0 + 1)) '$T/hc/hc.log' | grep -qE 'senha-errada|segredo-s3-teste|chave-service|chave-errada'"
  check "diretório temporário vazio" test -z "$(ls -A "$T/tmp")"
}

step "3. sabotagem: senha do banco errada"
sabotage senha 2026-11-02T08:15:00Z 'password authentication failed' "SUPABASE_DB_URL=postgresql://postgres:senha-errada@$ID-src:5432/postgres?sslmode=disable"
# media_failure NOME DATA ESPERADO_ERROS [CHAVE=valor ...] — mídia que não baixa NÃO
# segura o banco: o conjunto sobe inteiro, e o /fail dispara com a contagem.
media_failure() {
  local name=$1 stamp=$2 want=$3; shift 3
  write_env "cfg-$name" "$@"
  local h0 day; h0=$(hc_lines)
  run_backup "cfg-$name" "$stamp"
  day="daily/$(date -u -d "$stamp" +%Y-%m-%dT%H%M%SZ)"
  check "saiu com código ≠ 0 (alerta)" test "$RC" != 0
  check "o banco foi salvo assim mesmo (4 arquivos no R2)" test "$(keys "$day/" | wc -l)" = 4
  check "healthchecks recebeu /fail com a contagem" bash -c "tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r 'select(.path==\"/hc/diario/fail\") | .body' | grep -q 'midia_erros=$want'"
  check "nenhum ping de sucesso" bash -c "! tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r .path | grep -qx /hc/diario"
  mkdir -p "$T/out-$name"
  in_lib "bk_s3_get '$day/media.tar.age' '/t/out-$name/media.tar.age'"
  runner -w "/t/out-$name" "$RUNNER" bash -c 'age -d -i /t/key media.tar.age | tar -xf - INDICE.json'
  check "INDICE.json lista $want erro(s)" test "$(jq '.erros | length' "$T/out-$name/INDICE.json")" = "$want"
  check "diretório temporário vazio" test -z "$(ls -A "$T/tmp")"
}

step "4. chave do Storage errada (401 em toda a mídia)"
media_failure storage 2026-11-03T08:15:00Z 4 "SUPABASE_SERVICE_ROLE_KEY=chave-errada"

step "4b. um objeto quebrado (500, como o Storage real com arquivo sumido)"
echo "insert into storage.objects (bucket_id, name, metadata) values ('whatsapp-media', 'org1/conv1/quebrado.jpg', '{\"size\":5}')" | src_sql supabase_admin
media_failure quebrado 2026-11-03T09:15:00Z 1
check "os outros objetos foram copiados (3 no índice)" test "$(jq '.objetos | length' "$T/out-quebrado/INDICE.json")" = 3
echo "delete from storage.objects where name = 'org1/conv1/quebrado.jpg'" | src_sql supabase_admin
step "5. sabotagem: R2 fora do ar"
sabotage r2 2026-11-04T08:15:00Z 'Failed to connect|Could not connect' "R2_ENDPOINT=http://$ID-stubs:9"

step "6. sabotagem: backup.env com permissão 644"
write_env cfg-644
chmod 644 "$T/cfg-644/backup.env"
h0=$(hc_lines)
run_backup cfg-644 2026-11-05T08:15:00Z
check "recusou (código ≠ 0)" test "$RC" != 0
check "mensagem explica a permissão 600" grep -q 'permissão 600' "$T/out.log"
check "nem chegou a pingar" test "$(hc_lines)" = "$h0"

step "7. sabotagem: chave age inválida"
write_env cfg-age "AGE_RECIPIENT=age1naoehumachave"
run_backup cfg-age 2026-11-06T08:15:00Z
check "recusou (código ≠ 0)" test "$RC" != 0
check "mensagem cita AGE_RECIPIENT" grep -q AGE_RECIPIENT "$T/out.log"

step "8. execução concorrente (lock ocupado)"
h0=$(hc_lines)
flock "$T/cfg/backup.lock" bash -c "$(declare -f runner run_backup); RUNNER=$RUNNER NET=$NET UGID=$UGID HERE='$HERE' T='$T'; run_backup cfg 2026-11-07T08:15:00Z; echo \$RC >'$T/rc-lock'"
check "saiu com 0 sem rodar" test "$(cat "$T/rc-lock")" = 0
check "avisou que há outro em andamento" grep -q 'outro backup em andamento' "$T/out.log"
check "nenhum ping (quem está rodando é quem pinga)" test "$(hc_lines)" = "$h0"
check "nenhum arquivo enviado" test -z "$(keys daily/2026-11-07)"

# ───────────────────────────────────────────────────────────────────────────
# Restauração. O restore-test.sh roda no host (como na VPS) e enxerga o R2 e o
# healthchecks pelas portas publicadas em 127.0.0.1.
S3P=$(docker port "$ID-s3" 7070/tcp | head -n 1 | sed 's/.*://')
HCP=$(docker port "$ID-stubs" 8000/tcp | head -n 1 | sed 's/.*://')
write_env cfg-host "R2_ENDPOINT=http://127.0.0.1:$S3P" "HC_RESTORE_PING_URL=http://127.0.0.1:$HCP/hc/trimestral"
mkdir -p "$T/rtmp"

# run_restore [PREFIXO] < chave — código em $RC, saída em $T/rout.log
run_restore() {
  set +e
  BACKUP_ENV="$T/cfg-host/backup.env" RESTORE_TMPDIR="$T/rtmp" bash "$HERE/restore-test.sh" "$@" >"$T/rout.log" 2>&1
  RC=$?
  set -e
}
restore_containers() { docker ps -aq --filter name=cemed-restore- | wc -l; }

# tamper ORIGEM DESTINO MODO [EXPR_JQ] — copia um conjunto adulterado para DESTINO.
#   manifest  aplica EXPR_JQ ao manifest     cifra  vira 1 byte do db.dump.age
#   midia     troca 1 byte de um arquivo de mídia e recalcula o sha do tar no manifest
tamper() {
  runner -e SRC="$1" -e DST="$2" -e MODE="$3" -e JQ="${4:-.}" "$RUNNER" bash -c '
    set -e; . /bk/_lib.sh; bk_load_env /t/cfg/backup.env
    WORK=$(mktemp -d); cd "$WORK"
    for f in manifest.json db.dump roles.sql media.tar; do bk_s3_get "$SRC/$f.age" "$f.age"; done
    age -d -i /t/key -o manifest.json manifest.json.age
    case $MODE in
      manifest) jq "$JQ" manifest.json >m2 && mv m2 manifest.json ;;
      cifra) python3 -I -c "import sys; b=bytearray(open(sys.argv[1],\"rb\").read()); b[300]^=0xFF; open(sys.argv[1],\"wb\").write(b)" db.dump.age ;;
      midia)
        mkdir x && age -d -i /t/key media.tar.age | tar -x -C x
        python3 -I -c "import sys; p=sys.argv[1]; b=bytearray(open(p,\"rb\").read()); b[10]^=0xFF; open(p,\"wb\").write(b)" x/whatsapp-media/org1/conv1/msg1.jpg
        tar -C x -cf - whatsapp-media INDICE.json | age -r "$AGE_RECIPIENT" -o media.tar.age
        jq --arg s "$(sha256sum media.tar.age | cut -d" " -f1)" ".arquivos[\"media.tar.age\"].sha256 = \$s" manifest.json >m2 && mv m2 manifest.json ;;
    esac
    age -r "$AGE_RECIPIENT" -o manifest.json.age manifest.json
    for f in db.dump roles.sql media.tar manifest.json; do bk_s3_put "$DST/$f.age" "$f.age"; done'
}

# restore_fails NOME PREFIXO MOTIVO_REGEX [arquivo da chave]
restore_fails() {
  local h0; h0=$(hc_lines)
  run_restore "$2" <"${4:-$T/key}"
  check "$1: reprovou (código ≠ 0)" test "$RC" != 0
  check "$1: a saída diz o motivo" grep -qE "$3" "$T/rout.log"
  check "$1: /fail no check trimestral, com o motivo" bash -c "tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r 'select(.path==\"/hc/trimestral/fail\") | .body' | grep -qE '$3'"
  check "$1: o /fail não vaza a chave privada" bash -c "! tail -n +$((h0 + 1)) '$T/hc/hc.log' | grep -q AGE-SECRET-KEY"
  check "$1: contêiner descartado" test "$(restore_containers)" = 0
  check "$1: temporário vazio" test -z "$(ls -A "$T/rtmp")"
}

step "R1. restauração do diário limpo: tudo bate com o manifest"
h0=$(hc_lines)
run_restore daily/2026-11-01T090000Z <"$T/key"
check "restore-test.sh saiu com 0" test "$RC" = 0
[ "$RC" = 0 ] || sed 's/^/     | /' "$T/rout.log"
check "zero divergências" grep -q 'divergencias=0' "$T/rout.log"
check "contou as mesmas tabelas que o backup" grep -q "tabelas=$(jq '.banco.tables | length' "$T/out/manifest.json") " "$T/rout.log"
check "mídia conferida (3 arquivos, 1 ausente)" grep -q 'midia=3 ausentes=1 ' "$T/rout.log"
check "manifest registrou a tabela na publicação do Realtime" test "$(jq -r '.banco.publications[0]' "$T/out/manifest.json")" = "supabase_realtime public.pacientes"
check "healthchecks trimestral: /start e sucesso" \
  bash -c "tail -n +$((h0 + 1)) '$T/hc/hc.log' | jq -r .path | tr '\n' ' ' | grep -qx '/hc/trimestral/start /hc/trimestral '"
check "contêiner descartado" test "$(restore_containers)" = 0
check "temporário vazio (os cifrados baixados foram apagados)" test -z "$(ls -A "$T/rtmp")"
check "a chave não aparece na saída" bash -c "! grep -q AGE-SECRET-KEY '$T/rout.log'"

step "R2. sem argumento: pega o diário completo mais recente; erro de mídia do backup vira aviso"
run_restore <"$T/key"
check "saiu com 0" test "$RC" = 0
check "escolheu daily/2026-11-03T091500Z" grep -q 'conjunto: daily/2026-11-03T091500Z' "$T/rout.log"
check "avisa do objeto que falhou no backup" grep -q '1 objeto(s) já tinham falhado no backup' "$T/rout.log"

step "R3. restauração do mensal"
run_restore monthly/2026-11/2026-11-01T081500Z <"$T/key"
check "saiu com 0" test "$RC" = 0

step "R4. sabotagens"
tamper daily/2026-11-01T090000Z daily/2026-12-01T000001Z manifest '.banco.tables["public.pacientes"] = 251'
restore_fails "contagem adulterada" daily/2026-12-01T000001Z 'tabela public.pacientes: backup=251 restaurado=250'
tamper daily/2026-11-01T090000Z daily/2026-12-01T000002Z manifest '.banco.acl_relations += 1'
restore_fails "grant a mais no manifest" daily/2026-12-01T000002Z 'acl_relations: backup=[0-9]+ restaurado='
tamper daily/2026-11-01T090000Z daily/2026-12-01T000003Z manifest '.banco.rls_tables += 1'
restore_fails "RLS a mais no manifest" daily/2026-12-01T000003Z 'rls_tables: backup=[0-9]+ restaurado='
tamper daily/2026-11-01T090000Z daily/2026-12-01T000006Z manifest '.banco.publications += ["supabase_realtime public.fantasma"]'
restore_fails "publicação a mais no manifest" daily/2026-12-01T000006Z 'publicação perdida: supabase_realtime public.fantasma'
tamper daily/2026-11-01T090000Z daily/2026-12-01T000004Z cifra
restore_fails "cifrado corrompido" daily/2026-12-01T000004Z 'db.dump.age não confere com o manifest'
tamper daily/2026-11-01T090000Z daily/2026-12-01T000005Z midia
restore_fails "mídia trocada" daily/2026-12-01T000005Z 'mídia: .*msg1.jpg: FAILED'
runner "$RUNNER" age-keygen -o /t/outra.key 2>/dev/null
restore_fails "chave errada" daily/2026-11-01T090000Z 'a chave não decifra este backup' "$T/outra.key"

step "R5. entrada que não é chave"
h0=$(hc_lines)
set +e
echo "não sou uma chave" | BACKUP_ENV="$T/cfg-host/backup.env" RESTORE_TMPDIR="$T/rtmp" bash "$HERE/restore-test.sh" >"$T/rout.log" 2>&1
RC=$?
set -e
check "recusou antes de baixar (código ≠ 0)" test "$RC" != 0
check "explica que não é chave age" grep -q 'não é uma chave privada age' "$T/rout.log"
check "nem pingou" test "$(hc_lines)" = "$h0"

echo
if [ "$FAILS" -eq 0 ]; then
  printf '\033[32mTODOS OS CASOS PASSARAM\033[0m\n'
else
  printf '\033[31m%d VERIFICAÇÃO(ÕES) FALHARAM\033[0m\n' "$FAILS"
  exit 1
fi
