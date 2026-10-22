# shellcheck shell=bash
# Funções comuns do backup externo (backup.sh e restore-test.sh). Carregue com `.`.
#
# Regra deste diretório: credencial NUNCA vai para argv (aparece no `ps` de quem
# divide a máquina), nunca é ecoada e nunca sai num ping sem passar por bk_redact.
# O curl recebe a credencial por `-K <(…)` (pipe), o libpq por PGPASSWORD.

# Chaves aceitas no backup.env. Linha com outra chave reprova o arquivo inteiro:
# erro de digitação em nome de variável não pode virar "backup sem mídia" calado.
BK_ALLOWED_KEYS="SUPABASE_DB_URL SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_ENDPOINT R2_REGION
HC_PING_URL HC_RESTORE_PING_URL AGE_RECIPIENT BACKUP_MEDIA_BUCKETS
TARGET_DB_URL TARGET_SUPABASE_URL TARGET_SERVICE_ROLE_KEY"

# Hash SHA-256 do corpo vazio (GET/LIST no S3 assinam o payload também).
BK_EMPTY_SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

BK_RID="${BK_RID:-$(cat /proc/sys/kernel/random/uuid)}"

bk_log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
bk_die() { bk_log "ERRO: $*" >&2; exit 1; }

# bk_load_env ARQUIVO — lê KEY=VALUE como dado (sem `source`: senha com `$` não
# expande), só de arquivo 600 do próprio usuário. As variáveis NÃO são exportadas;
# cada comando recebe só o que precisa.
bk_load_env() {
  local f=$1 line key val n=0
  [ -f "$f" ] || bk_die "arquivo de credenciais ausente: $f"
  [ "$(stat -c '%a %u' "$f")" = "600 $(id -u)" ] \
    || bk_die "$f precisa ter permissão 600 e ser do usuário $(id -u) (está $(stat -c '%a, dono %u' "$f"))"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line=${line%$'\r'}
    case $line in '' | '#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    # Nunca imprime a linha: pode ser um segredo colado sem a chave.
    [ "$key" != "$line" ] || bk_die "$f, linha $n: sem '='"
    case " ${BK_ALLOWED_KEYS//$'\n'/ } " in
      *" $key "*) ;;
      *) bk_die "$f, linha $n: chave não reconhecida" ;;
    esac
    case $val in
      \"*\" | \'*\') val=${val:1:${#val}-2} ;;
    esac
    printf -v "$key" '%s' "$val"
  done <"$f"
}

bk_require() {
  local v
  for v in "$@"; do
    [ -n "${!v:-}" ] || bk_die "variável obrigatória vazia no backup.env: $v"
  done
}

# bk_pg_env [URL] — a URL (padrão: SUPABASE_DB_URL) vira PGHOST/PGPORT/PGUSER/
# PGPASSWORD/PGDATABASE/PGSSLMODE. Nunca chega ao argv do pg_dump/psql.
# sslmode padrão: require.
bk_pg_env() {
  local out url=${1:-$SUPABASE_DB_URL}
  local -a f
  out=$(BK_URL="$url" python3 -I -c '
import os, urllib.parse as u
p = u.urlsplit(os.environ["BK_URL"])
q = dict(u.parse_qsl(p.query))
for v in (p.hostname, p.port or 5432, u.unquote(p.username or ""), u.unquote(p.password or ""),
          u.unquote(p.path[1:]) or "postgres", q.get("sslmode", "require")):
    print(v or "")
') || bk_die "SUPABASE_DB_URL não é uma URL postgresql:// válida"
  mapfile -t f <<<"$out"
  if [ -z "${f[0]}" ] || [ -z "${f[2]}" ]; then bk_die "SUPABASE_DB_URL sem host ou usuário"; fi
  export PGHOST="${f[0]}" PGPORT="${f[1]}" PGUSER="${f[2]}" PGPASSWORD="${f[3]}" \
    PGDATABASE="${f[4]}" PGSSLMODE="${f[5]}" PGAPPNAME=cemed-backup
}

# bk_decrypt_set ENTRADA SAÍDA — decifra o conjunto (manifest, dump, roles e mídia)
# com a chave em $KEY, depois de conferir o sha256 de cada cifrado com o manifest.
# Rode só onde SAÍDA é tmpfs: o resultado é dado de paciente em claro.
bk_decrypt_set() {
  local in=$1 out=$2 f want got
  age -d -i <(printf '%s\n' "$KEY") -o "$out/manifest.json" "$in/manifest.json.age" 2>"$out/age.err" \
    || bk_die "a chave não decifra este backup: $(head -c 300 "$out/age.err")"
  [ "$(jq -r .formato "$out/manifest.json")" = 1 ] || bk_die "manifest em formato desconhecido"
  for f in db.dump.age roles.sql.age media.tar.age; do
    want=$(jq -r --arg f "$f" '.arquivos[$f].sha256' "$out/manifest.json")
    got=$(sha256sum "$in/$f" | cut -d' ' -f1)
    [ "$want" = "$got" ] || bk_die "$f não confere com o manifest (corrompido ou de outro conjunto)"
  done
  bk_log "manifest ok: conjunto $(jq -r .stamp "$out/manifest.json"), commit $(jq -r .commit "$out/manifest.json"), Postgres $(jq -r .banco.server_version "$out/manifest.json")"
  age -d -i <(printf '%s\n' "$KEY") -o "$out/db.dump" "$in/db.dump.age"
  age -d -i <(printf '%s\n' "$KEY") -o "$out/roles.sql" "$in/roles.sql.age"
  mkdir -p "$out/media"
  age -d -i <(printf '%s\n' "$KEY") "$in/media.tar.age" | tar -x -C "$out/media"
}

# bk_restore_publications — recria a filiação das tabelas às publicações a partir
# do manifest em $R/manifest.json (a função q do chamador conecta no destino).
bk_restore_publications() {
  local pub tab
  while read -r pub tab; do
    q -c "do \$\$ begin
            if not exists (select 1 from pg_publication where pubname = '$pub') then
              execute 'create publication $pub';
            end if;
            if not exists (select 1 from pg_publication_tables
                           where pubname = '$pub' and format('%I.%I', schemaname, tablename) = '$tab') then
              execute 'alter publication $pub add table $tab';
            end if;
          end \$\$" >/dev/null 2>&1 \
      || bk_log "aviso: não consegui pôr $tab na publicação $pub (a conferência vai apontar)"
  done < <(jq -r '.banco.publications // [] | .[]' "$R/manifest.json")
}

# bk_stats_sql — UMA linha de JSON com a contagem exata de linhas de cada tabela de
# public/auth/storage, policies RLS, tabelas com RLS ligada e a LISTA de grants
# ("tipo objeto quem:privilégio", * = with grant option) de tabelas, sequências,
# views, funções, dos próprios schemas e dos default privileges. É o privilégio
# EFETIVO: ACL nula vale o padrão do dono (acldefault), senão "dono implícito" e
# "dono explícito" pareceriam diferentes. Quem concedeu (grantor) fica de fora de
# propósito: o acesso depende de quem recebe.
# Objetos que pertencem a extensões (vector, citext, pg_trgm moram em public) ficam
# de fora: quem os recria no restore é o CREATE EXTENSION, não o dump.
# 'publications' lista "publicação schema.tabela": o pg_dump com --schema NÃO
# exporta publicações, e sem elas o Realtime (inbox ao vivo) para — os restores
# recriam a filiação a partir daqui.
# O backup roda no snapshot do dump (vai para o manifest); o restore roda a MESMA
# consulta no banco restaurado e exige igualdade.
bk_stats_sql() {
  local s="'public','auth','storage'"
  local not_ext_rel="not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')"
  local not_ext_fn="not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')"
  cat <<SQL
with obj as (
  select 'rel' as kind, format('%I.%I', n.nspname, c.relname) as name,
      coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner)) as acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ($s) and c.relkind in ('r','p','v','m','S','f') and $not_ext_rel
  union all
  select 'fn', format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)),
      coalesce(p.proacl, acldefault('f'::"char", p.proowner))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ($s) and $not_ext_fn
  union all
  select 'schema', format('%I', n.nspname), coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))
    from pg_namespace n where n.nspname in ($s)
  union all
  select 'default', format('%s/%s/%s', pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype), d.defaclacl
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
    where n.nspname in ($s)
), acl as (
  select distinct o.kind, format('%s %s %s:%s%s', o.kind, o.name,
      case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
      a.privilege_type, case when a.is_grantable then '*' else '' end) as entry
    from obj o, aclexplode(o.acl) a
)
select json_build_object(
  'taken_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'server_version', current_setting('server_version'),
  'tables', (select json_object_agg(format('%I.%I', n.nspname, c.relname),
      (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from only %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
      order by n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and n.nspname in ($s) and $not_ext_rel),
  'policies', (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname in ($s)),
  'rls_tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relrowsecurity and n.nspname in ($s)),
  'acl_relations', (select count(*) from acl where kind = 'rel'),
  'acl_functions', (select count(*) from acl where kind = 'fn'),
  'acl', (select coalesce(json_agg(entry order by entry), '[]') from acl),
  'publications', (select coalesce(json_agg(format('%I %I.%I', pubname, schemaname, tablename)
      order by pubname, schemaname, tablename), '[]')
    from pg_publication_tables where schemaname in ($s)),
  'extensions', (select json_agg(json_build_object('name', e.extname, 'schema', n.nspname) order by e.extname)
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace));
SQL
}

# bk_redact TEXTO — troca todo valor de credencial conhecido por <redigido>.
bk_redact() {
  local s=$1 v
  for v in "${SUPABASE_DB_URL:-}" "${PGPASSWORD:-}" "${SUPABASE_SERVICE_ROLE_KEY:-}" \
    "${TARGET_DB_URL:-}" "${TARGET_SERVICE_ROLE_KEY:-}" \
    "${R2_ACCOUNT_ID:-}" "${R2_ACCESS_KEY_ID:-}" "${R2_SECRET_ACCESS_KEY:-}" \
    "${HC_PING_URL:-}" "${HC_RESTORE_PING_URL:-}"; do
    # Valor curto não é credencial de verdade e trocá-lo mutila o texto todo.
    [ "${#v}" -ge 8 ] && s=${s//"$v"/<redigido>}
  done
  printf '%s' "$s" | sed -E 's#postgres(ql)?://[^[:space:]]+#<url-redigida>#g'
}

# Valor dentro de aspas num arquivo de config do curl.
bk_curl_quote() { local s=${1//\\/\\\\}; printf '"%s"' "${s//\"/\\\"}"; }

# bk_hc URL_BASE SUFIXO [CORPO] — ping no healthchecks.io. Falha no ping é avisada,
# nunca derruba nem mascara o resultado do backup.
bk_hc() {
  local base=$1 suffix=$2 body=${3:-}
  [ -n "$base" ] || return 0
  body=$(bk_redact "$body")
  # O healthchecks guarda até 100 kB; fica o fim, que é onde está o erro.
  [ "${#body}" -le 90000 ] || body=${body: -90000}
  curl -fsS -m 10 --retry 5 -o /dev/null --data-raw "$body" \
    -K <(printf 'url = %s\n' "$(bk_curl_quote "${base%/}${suffix}?rid=${BK_RID}")") \
    || bk_log "aviso: ping no healthchecks falhou (${suffix:-sucesso})"
  return 0
}

bk_s3_url() { printf '%s/%s/%s' "${R2_ENDPOINT%/}" "$R2_BUCKET" "$1"; }

# Credencial e assinatura SigV4 do R2 (região "auto"), via config do curl.
bk_s3_cfg() {
  printf 'user = %s\n' "$(bk_curl_quote "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY")"
  printf 'aws-sigv4 = %s\n' "$(bk_curl_quote "aws:amz:${R2_REGION:-auto}:s3")"
}

# bk_s3_put CHAVE ARQUIVO — PUT único; confere ETag == MD5 local (integridade do
# que chegou). Sobrescrita é recusada pelo bucket lock: as chaves levam o horário.
bk_s3_put() {
  local key=$1 file=$2 sha md5 etag hdrs resp
  sha=$(sha256sum "$file" | cut -d' ' -f1)
  md5=$(md5sum "$file" | cut -d' ' -f1)
  resp=$(mktemp "${WORK:-/tmp}/s3resp.XXXXXX")
  if ! hdrs=$(curl -sS --fail-with-body -m 900 --retry 3 -K <(bk_s3_cfg) \
    -H "x-amz-content-sha256: $sha" -T "$file" -D - -o "$resp" "$(bk_s3_url "$key")"); then
    bk_log "resposta do R2: $(head -c 600 "$resp")"
    rm -f "$resp"
    return 1
  fi
  rm -f "$resp"
  etag=$(printf '%s' "$hdrs" | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}' | tr -d '"')
  [ "$etag" = "$md5" ] || { bk_log "ETag do R2 ($etag) diferente do MD5 local ($md5) em $key"; return 1; }
}

# bk_s3_get CHAVE DESTINO
bk_s3_get() {
  curl -sS --fail-with-body -m 900 --retry 3 -K <(bk_s3_cfg) \
    -H "x-amz-content-sha256: $BK_EMPTY_SHA256" -o "$2" "$(bk_s3_url "$1")"
}

# bk_s3_keys PREFIXO — uma chave por linha, em ordem (UTC no nome = cronológica),
# paginando de 1000 em 1000.
bk_s3_keys() {
  local token="" xml page
  while :; do
    xml=$(curl -sS --fail-with-body -m 60 --retry 3 -K <(bk_s3_cfg) \
      -H "x-amz-content-sha256: $BK_EMPTY_SHA256" -G \
      --data-urlencode list-type=2 --data-urlencode max-keys=1000 --data-urlencode "prefix=$1" \
      ${token:+--data-urlencode "continuation-token=$token"} \
      "${R2_ENDPOINT%/}/${R2_BUCKET}") || { bk_log "não consegui listar $1 no R2"; return 1; }
    page=$(printf '%s' "$xml" | python3 -I -c '
import sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.buffer.read())
nxt = ""
for el in root.iter():
    tag = el.tag.rsplit("}", 1)[-1]
    if tag == "Key":
        print(el.text)
    elif tag == "NextContinuationToken":
        nxt = el.text or ""
print("@@next " + nxt)
') || return 1
    printf '%s\n' "$page" | grep -v '^@@next ' || true
    token=$(printf '%s\n' "$page" | sed -n 's/^@@next //p')
    [ -n "$token" ] || return 0
  done
}
