# Runbook — Log de acesso do Caddy

O Caddy grava **uma linha JSON por requisição** que passa pelo proxy. A configuração fica no bloco `log` do `Caddyfile`. Antes não havia log de acesso nenhum, só erros, e por isso não dava para responder perguntas como "alguma senha passou na URL?" pelos logs do servidor.

## Onde fica

| | |
|---|---|
| Arquivo atual | `/data/access.log` **dentro** do contêiner do Caddy (`<projeto>-caddy-1`, ex.: `cemed-chat-caddy-1`) |
| Volume | `/data` é o volume `<projeto>_caddy-data` (o mesmo dos certificados). Sobrevive a restart e a recriação do contêiner. |
| Rotação | Arquivo novo a cada **10 MiB**. Ficam **10** arquivos antigos, e nenhum com mais de **30 dias**: no máximo ~110 MiB. |
| Arquivos girados | `/data/access-<data-hora>.log.gz` (comprimidos) |

Nos exemplos abaixo, `C=cemed-chat-caddy-1`. Para descobrir o nome em outra instalação, rode `docker compose -f docker-compose.prod.yml ps caddy`.

## O que tem e o que não tem

Cada linha traz **só** estes campos:
- `ts` (epoch);
- `status`, `duration`, `size`, `bytes_read`;
- `request.method`, `request.uri` (redigida), `request.host`, `request.proto`;
- `request.client_ip`, `request.remote_ip`, `request.remote_port`;
- `user_agent`.

**Nenhum header de requisição ou de resposta entra no log.** É lista branca: o filtro apaga `request.headers` e `resp_headers` inteiros, e o `User-Agent` volta à parte (`log_append`).

A primeira versão usava lista negra (apagava `Authorization`, `Cookie` etc.) e vazava. Medido com o app real:
- o app devolve **`X-Pathname`** com o caminho completo, incluindo o token do convite;
- o **`Location`** do redirect leva `?next=<caminho>`;
- a navegação do Next manda **`Next-Url`** e `Next-Router-State-Tree` com os parâmetros da rota;
- qualquer header customizado de cliente também entrava.

Com a lista branca, um header novo não entra sem alguém decidir.

**Na URI, viram `REDACTED`:**

| Onde | Exemplo |
|---|---|
| Token no caminho | `/api/v1/webhooks/<canal>/<token>`, `/team/accept-invite/<token>` |
| O mesmo caminho codificado dentro de um parâmetro | `?next=%2Fteam%2Faccept-invite%2F<token>` |
| Valor de todo parâmetro cujo **nome contém** `token`, `secret`, `password`, `senha`, `pass`, `code`, `key`, `email`, `search` ou `cpf` (sem diferenciar maiúscula) | pega `token_hash` dos links do Supabase, `access_token`, `api_key` e a **busca**, que pode ser nome, telefone ou CPF de paciente |
| O mesmo parâmetro codificado dentro do `next` de um redirect | `?next=%2Fapp%2Fcontacts%3Fsearch%3D<valor>` |

O **nome** do parâmetro fica. Assim ainda dá para ver que houve, por exemplo, tentativa de login com `password=` na URL. Corpo de requisição ou resposta o Caddy nunca registra.

**Prova (2026-10-20).** A imagem de produção do app rodou atrás de um Caddy descartável com este Caddyfile, e o Playwright gerou tráfego real com um token de convite válido de teste em todo lugar possível: caminho, `?next=`, `token_hash`, `code`, `search`, redirect de página protegida, navegação logada do Next, chamada de API e headers forjados.
- Em 158 linhas, o token inteiro, cada metade dele e os e-mails apareceram **0 vezes**.
- Com o mesmo tráfego, o Caddyfile anterior vazou o token em **154** linhas.

O **IP de origem fica**, porque é o que serve para auditoria. Por isso o arquivo também é **dado pessoal (LGPD)**: não copie para fora do servidor sem necessidade e apague as cópias depois do uso.

## Consultas

```bash
C=cemed-chat-caddy-1

# últimas 20 requisições, legível
docker exec $C cat /data/access.log | tail -n 20 \
  | jq -r '[(.ts|todate), .status, .request.method, .request.uri, .request.client_ip, .user_agent] | @tsv'

# acompanhar ao vivo
docker exec $C tail -f /data/access.log | jq -r '[.status, .request.method, .request.uri] | @tsv'

# erros 5xx
docker exec $C cat /data/access.log | jq -c 'select(.status >= 500) | {t: (.ts|todate), s: .status, u: .request.uri}'

# alguém tentou login com credencial na URL? (o valor some, mas o NOME do parâmetro fica)
docker exec $C cat /data/access.log | jq -c 'select(.request.uri | test("[?&](password|senha)=")) | {t: (.ts|todate), ip: .request.client_ip, u: .request.uri}'

# quem bateu no webhook global (bloqueado com 403)
docker exec $C cat /data/access.log | jq -c 'select(.request.uri == "/api/v1/webhooks/waha") | {t: (.ts|todate), s: .status, ip: .request.client_ip}'

# IPs com mais requisições
docker exec $C cat /data/access.log | jq -r '.request.client_ip' | sort | uniq -c | sort -rn | head

# incluir os arquivos já girados (comprimidos)
docker exec $C sh -c 'zcat /data/access-*.log.gz 2>/dev/null; cat /data/access.log' | jq -c 'select(.status == 404)'

# copiar para o host (lembre: é dado pessoal — apague depois)
docker cp $C:/data/access.log ./access.log
```

O `jq` roda **no host**, porque a imagem do Caddy não tem `jq`. Sem ele, use `grep` direto na linha JSON.

## Limpar linhas de teste (ou recomeçar o arquivo)

Para descartar o log atual depois de testes, por exemplo, sem parar o Caddy:

```bash
C=cemed-chat-caddy-1
docker exec $C sh -c ': > /data/access.log'      # zera o arquivo atual (o Caddy segue escrevendo nele)
docker exec $C sh -c 'rm -f /data/access-*.log.gz' # e, se quiser, os arquivos já girados
```

Para remover só algumas linhas, filtre para um arquivo novo e troque:

```bash
docker exec $C sh -c 'grep -v "<marcador do teste>" /data/access.log > /data/access.tmp && cat /data/access.tmp > /data/access.log && rm /data/access.tmp'
```

O `cat >` reescreve o **mesmo** arquivo, e por isso o Caddy continua escrevendo nele. Um `mv` trocaria o arquivo, e o Caddy seguiria escrevendo no antigo até a próxima rotação.

## Ativação depois de um deploy que muda o `Caddyfile`

O `Caddyfile` entra no contêiner por bind mount de **um arquivo**, e esse mount fica preso ao inode. O `git pull` grava um arquivo novo, com outro inode, e o contêiner continua lendo o antigo. O `update.sh` do kit já trata disso. No deploy manual:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate caddy
```

A recriação derruba o HTTPS por alguns segundos. Depois dela, confirme:

```bash
docker exec cemed-chat-caddy-1 ls -la /data/access.log   # existe e cresce a cada requisição
curl -s -o /dev/null -w '%{http_code}\n' https://<seu-domínio>/   # 307
```
