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
HC_PING_URL HC_RESTORE_PING_URL AGE_RECIPIENT BACKUP_MEDIA_BUCKETS"

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

# bk_pg_env — SUPABASE_DB_URL vira PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE.
# A URL nunca chega ao argv do pg_dump/psql. sslmode padrão: require.
bk_pg_env() {
  local out
  local -a f
  out=$(BK_URL="$SUPABASE_DB_URL" python3 -I -c '
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

# bk_redact TEXTO — troca todo valor de credencial conhecido por <redigido>.
bk_redact() {
  local s=$1 v
  for v in "${SUPABASE_DB_URL:-}" "${PGPASSWORD:-}" "${SUPABASE_SERVICE_ROLE_KEY:-}" \
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

# bk_s3_keys PREFIXO — uma chave por linha (até 1000; o prefixo é sempre estreito).
bk_s3_keys() {
  curl -sS --fail-with-body -m 60 --retry 3 -K <(bk_s3_cfg) \
    -H "x-amz-content-sha256: $BK_EMPTY_SHA256" \
    "${R2_ENDPOINT%/}/${R2_BUCKET}?list-type=2&max-keys=1000&prefix=$1" \
    | python3 -I -c '
import sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.buffer.read())
for el in root.iter():
    if el.tag.rsplit("}", 1)[-1] == "Key":
        print(el.text)
'
}
