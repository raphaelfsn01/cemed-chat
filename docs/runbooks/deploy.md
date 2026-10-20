# Runbook — Deploy em produção (VPS)

O caminho normal de deploy **não constrói nada na VPS**: o CI publica a imagem no
GHCR e a VPS só puxa. Construir localmente é exceção de emergência, e tem custo —
está documentado no fim.

---

## 0. Antes de tudo: qual proxy esta máquina usa?

O comando de deploy **depende do proxy**, e o comando errado derruba o domínio.
Existem duas topologias, e as duas já derrubaram o site quando confundidas:

| Topologia | Quem serve 80/443 | Arquivos de compose em TODO `up -d` |
|---|---|---|
| **A — Caddy do próprio compose** (VPS "crua"; é a **VPS de produção do CEMED**) | contêiner `<projeto>-caddy-1` | só `-f docker-compose.prod.yml` |
| **B — Traefik da hospedagem** (Hostinger, Coolify, Dokploy…) | o Traefik da hospedagem | `-f docker-compose.prod.yml -f docker-compose.traefik.yml` |

Como saber em que máquina você está, sem adivinhar — pergunte ao contêiner que
está rodando com quais arquivos ele foi criado:

```bash
docker inspect "$(docker compose -f docker-compose.prod.yml ps -q app)" \
  --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
# só .../docker-compose.prod.yml                          → topologia A (Caddy)
# .../docker-compose.prod.yml,.../docker-compose.traefik.yml → topologia B (Traefik)
```

O kit (`hostgator-setup-kit/`) decide pelo `REVERSE_PROXY` do `.env`: ausente ou
`caddy` → A; `traefik` → B. O `update.sh` e o `agent.sh` já seguem essa chave.

**Errar para cada lado:**
- Passar `-f docker-compose.traefik.yml` numa máquina **A** desliga o Caddy (ele
  ganha um profile que nunca é ativado) e prende o `app` a uma rede `traefik` que
  não existe: o `up -d` falha ou o domínio fica sem proxy.
- Omitir o `-f docker-compose.traefik.yml` numa máquina **B** recria o `app` sem
  as labels de roteamento: o Traefik deixa de enxergá-lo e o domínio inteiro
  responde `404 page not found` (o 404 genérico do Traefik) — com o contêiner
  `healthy`. Foi o que derrubou o site em 2026-08-05.

---

## 1. O comando

Rode no diretório do projeto (onde estão o `.env` e os `docker-compose*.yml`).
**Atualize o checkout para a `main` antes** — o compose lê os arquivos do disco
(Caddyfile, compose), não da imagem:

```bash
git pull --ff-only
```

**Topologia A (Caddy — a VPS de produção do CEMED):**

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d app
```

**Topologia B (Traefik da hospedagem):**

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Na B, o `docker-compose.traefik.yml` é o ÚNICO lugar que:

- coloca no contêiner `app` as labels de roteamento
  (`traefik.http.routers.deskcomm.rule=Host(...)`);
- associa o contêiner à rede que o Traefik enxerga (`TRAEFIK_NETWORK`, padrão
  `traefik`; o `install.sh` descobre a certa e grava no `.env`);
- desliga o `caddy` do compose base por profile (senão dois processos brigam
  pela mesma porta).

### Mudou o `Caddyfile`? (topologia A)

O `Caddyfile` entra no contêiner por bind mount de **um arquivo**, e esse mount
fica preso ao inode. O `git pull` grava um arquivo novo (inode novo) e o
contêiner continua lendo o antigo — para sempre, sem erro. Depois de um deploy
que mexe no `Caddyfile`:

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --force-recreate caddy
```

(O HTTPS cai por alguns segundos durante a recriação.) O `update.sh` do kit já
faz isso sozinho.

### Mudou o agente? (`lib/agent-engine`, `workers/`, `Dockerfile.worker`)

O serviço `worker` é **construído na VPS** (`build:` no compose, não `image:`):
o CI não publica imagem dele e o `update.sh` não o reconstrói. Um `up -d app`
não chega nele. Quando o merge mexe no agente:

```bash
docker compose -f docker-compose.prod.yml --env-file .env build worker
docker compose -f docker-compose.prod.yml --env-file .env up -d worker
# prove que o código novo está lá dentro (o healthy não prova):
md5sum lib/agent-engine/<arquivo>.ts
docker compose -f docker-compose.prod.yml exec worker md5sum /app/lib/agent-engine/<arquivo>.ts
```

---

## 2. Verificação pós-deploy (não pule)

`healthy` no `docker ps` **não prova que o site está acessível** — o healthcheck
é um probe interno e passa mesmo com o roteamento quebrado. Verifique:

```bash
APP="$(docker compose -f docker-compose.prod.yml ps -q app)"

# 1) a imagem nova está rodando? (compare com o commit que você mergeou)
docker inspect "$APP" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'

# 2) o contêiner foi criado com os arquivos certos para ESTA máquina?
docker inspect "$APP" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
#    topologia A: só docker-compose.prod.yml
#    topologia B: os dois — e então confira também as labels do Traefik:
docker inspect "$APP" --format '{{.Config.Labels}}' | grep -o 'traefik.enable:[^ ]*'
#    esperado na B: traefik.enable:true   (vazio = roteamento quebrado)

# 3) o domínio responde?
curl -s -o /dev/null -w "%{http_code}\n" https://<DOMAIN>/
# esperado: 307 (redireciona pro login)
# 404 na topologia B  = labels perdidas, refaça o deploy com os dois -f
# falha de conexão na A = Caddy fora; confira `docker compose ... ps caddy`
```

O nome do contêiner é `<pasta-do-projeto>-app-1`, por isso a pergunta vai ao
compose (`ps -q app`) em vez de chutar o nome. Um `-f` só basta para o `ps`: ele
resolve pelo nome do projeto + serviço, não pelo conteúdo do arquivo.

---

## 3. Fluxo completo (do código à produção)

```
commit → push → PR → merge na main → CI publica imagem → VPS puxa
```

1. **Commit + push** numa branch de feature. Trabalho que fica só no disco da
   VPS não existe: o CI não o vê, some se a VPS for reconstruída, e é invisível
   pra qualquer outra pessoa.
2. **PR e merge na `main`.** `publish-image.yml` dispara em push na `main` (ou
   tag `v*`) e publica `ghcr.io/<repo>:latest`. O build pesado (~6min) roda nos
   runners do GitHub, nunca na VPS do usuário.
3. **Deploy na VPS** com o comando da seção 1, para a topologia da máquina. Como
   o `.env` tem `APP_PULL_POLICY='always'`, o `up -d` já puxa a imagem nova
   sozinho.

Alternativa sem terminal: a tela **Configurações → Atualização** pede a
atualização, e o `hostgator-setup-kit/agent.sh` (cron de 5 em 5 min no servidor)
roda o `update.sh` — `git pull` + `pull` + `up -d` com rollback, já respeitando
o `REVERSE_PROXY` e recriando o Caddy. Ele **não** reconstrói o worker.

---

## 4. Exceção: imagem construída na VPS

Só quando é preciso validar algo em produção **antes** de a imagem oficial
existir (ex.: CI ainda rodando e um bug bloqueando o usuário).

```bash
APP_IMAGE=deskcomm-app:local docker compose \
  -f docker-compose.prod.yml -f docker-compose.build.yml --env-file .env build app

# topologia A:
APP_IMAGE=deskcomm-app:local APP_PULL_POLICY=never docker compose \
  -f docker-compose.prod.yml --env-file .env up -d app
# topologia B:
APP_IMAGE=deskcomm-app:local APP_PULL_POLICY=never docker compose \
  -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

**Isto é dívida, não um caminho paralelo.** A imagem existe só no disco daquela
VPS: não está no registry, não está no git, e qualquer `docker compose up -d`
sem `APP_PULL_POLICY=never` a substitui pela do GHCR — silenciosamente, sem erro
nenhum, revertendo o que você acabou de subir.

Requisitos: >= 4 GB de RAM **ou** swap (medido: ~4min num VPS de 3.8 GB com 4 GB
de swap). Na VPS de produção do CEMED, que é compartilhada com desenvolvimento,
confira `free -h` antes e rode um build por vez. Ao terminar, feche o ciclo —
merge na `main` e volte a VPS pra imagem oficial.

---

## 5. A VPS de produção do CEMED, em resumo

Topologia **A**. Detalhes (proxy, banco, Redis, WAHA, Sentry, IA) na seção
"Infraestrutura desta VPS" do `CLAUDE.md`; log de acesso do proxy em
[`caddy-log-de-acesso.md`](caddy-log-de-acesso.md).
