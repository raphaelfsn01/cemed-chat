# Runbook: backup externo e restauração

> O Supabase Free não faz backup nem tem PITR. Sem este processo, o RPO do CEMED Chat é
> infinito (auditoria de segurança de 2026-10-21, achado A1). Os scripts ficam em
> [`scripts/backup/`](../../scripts/backup). Este runbook diz como instalar, como testar
> a cada trimestre e o que fazer num desastre.

| | |
|---|---|
| **O quê** | Banco (`public` + `auth` + `storage`, com donos e grants), roles e a mídia do bucket `whatsapp-media` |
| **Quando** | Todo dia, 08:15 no relógio da VPS (Europe/Berlin), ou seja, 03:15 BRT no horário de verão europeu e 04:15 BRT no inverno |
| **Onde** | Cloudflare R2, bucket privado `cemed-backups-prod`. Tudo é cifrado com [age](https://age-encryption.org) **antes** de sair da VPS |
| **Chave** | Pública na VPS (`AGE_RECIPIENT`). A **privada só existe no gerenciador de senhas**; sem ela, nenhum backup abre |
| **Alerta** | healthchecks.io: `cemed-backup-diario` e `cemed-restore-trimestral` |
| **Prova** | Teste de restauração **trimestral** (`restore-test.sh`) e teste automatizado (`test-backup.sh`) |

## 1. O que cada execução gera

O `backup.sh` grava em `daily/<UTC>/`. A **primeira execução bem-sucedida de cada mês** grava
também em `monthly/<AAAA-MM>/<UTC>/`.

| Arquivo | Conteúdo |
|---|---|
| `db.dump.age` | `pg_dump --format=custom` de `public`, `auth` e `storage`, **com donos e grants** (as policies RLS e o acesso de `anon`/`authenticated` dependem deles) |
| `roles.sql.age` | `pg_dumpall --roles-only --no-role-passwords` |
| `media.tar.age` | Os objetos do `whatsapp-media` e um `INDICE.json` com o sha256 de cada um, a lista dos ausentes e a lista dos erros |
| `manifest.json.age` | Tirado **no mesmo snapshot do dump**: contagem exata de linhas de cada tabela, policies, tabelas com RLS, a lista de grants efetivos, as tabelas nas publicações do Realtime, as extensões e o sha256 de cada cifrado |

**Um conjunto só está completo se tiver o `manifest.json.age`**, porque ele sobe por último.
Conjunto sem manifest é resto de uma execução que falhou no meio e deve ser ignorado.

Garantias do script:

- Nada sai em claro: o `age` cifra no próprio pipe do `pg_dump`/`tar`, e só o cifrado passa
  pelo disco, num diretório temporário que é apagado no fim.
- Credencial nunca vai para o argv.
- O R2 confere a integridade de cada upload: o ETag precisa bater com o MD5 local.
- Mídia que não baixa não segura o banco. O conjunto inteiro sobe, os objetos com problema
  ficam listados no `INDICE.json` e o alerta dispara mesmo assim (código 3).

## 2. Retenção e proteção contra apagamento (R2)

**O script nunca apaga nada no bucket.** Quem cuida da retenção são as regras do próprio R2:

| Prefixo | Bucket lock (ninguém apaga nem sobrescreve) | Lifecycle (expira) |
|---|---|---|
| `daily/` | 30 dias | 31 dias |
| `monthly/` | **90 dias** | 91 dias |

- **O R2 não tem versionamento de objetos.** Quem protege é o **bucket lock**: nem um token
  vazado da VPS, nem você pelo painel, consegue apagar um backup antes do prazo. O lifecycle
  precisa ser ≥ o lock.
- **O lock não encurta depois de gravado.** Por isso o mensal começou em 90 dias. **Aumentar o
  prazo** (por exemplo, para 12 meses) **é decisão da CEMED com o encarregado (LGPD)**. Ao
  decidir, edite as duas regras do prefixo `monthly/` no painel do R2 e anote a data aqui.
- O token da VPS é **"Object Read & Write" restrito ao bucket `cemed-backups-prod`**. Ele não
  altera regras de lock, porque isso exige token Admin.

## 3. Alertas

| Check no healthchecks.io | Período / tolerância | Quem pinga | Quando avisa |
|---|---|---|---|
| `cemed-backup-diario` | 1 dia / 2 h | `backup.sh` (`/start`, sucesso, `/fail`) | O backup falhou, ou não rodou (silêncio por mais de 26 h) |
| `cemed-restore-trimestral` | 92 dias / 7 dias | `restore-test.sh` | O teste trimestral reprovou, ou ficou ~99 dias sem rodar |

O corpo do ping traz o diagnóstico. No sucesso, vêm os tamanhos e as contagens. No `/fail`,
vêm as últimas linhas do log, já **redigidas**: senha, chave e URL do banco viram `<redigido>`.

| Mensagem no `/fail` | Causa provável | O que fazer |
|---|---|---|
| `password authentication failed` | Senha do banco trocada | Atualize `SUPABASE_DB_URL` no `backup.env` |
| `ETag do R2 … diferente` ou `resposta do R2: …` | Token do R2 revogado ou expirado, ou R2 fora do ar | Confira o token; se for instabilidade, o dia seguinte refaz |
| `midia_erros=N` / código 3 | N objetos do Storage não baixaram (no Storage real, arquivo sumido responde 500) | O banco **foi salvo**. Veja quais objetos falharam no `INDICE.json` do dia |
| silêncio (alerta de atraso) | O cron não rodou: VPS parada, crontab perdido ou outro backup ainda segurando o lock | `crontab -l`; `tail ~/.config/cemed-backup/backup.log` |

## 4. Instalação na VPS (uma vez; **cada etapa só com o OK do Raphael**)

### 4.1 R2 (painel da Cloudflare)

1. Crie o bucket **`cemed-backups-prod`**, privado, na localização automática.
2. Em **Settings → Bucket lock rules**, crie 2 regras: prefixo `daily/` com idade de 30 dias,
   e prefixo `monthly/` com idade de 90 dias.
3. Em **Settings → Object lifecycle rules**, crie 2 regras: prefixo `daily/` apagando após
   31 dias, e prefixo `monthly/` apagando após 91 dias.
4. Em **R2 → Manage API tokens**, crie um token com a permissão **Object Read & Write**,
   **aplicado só ao bucket `cemed-backups-prod`**. Anote o Access Key ID, o Secret e o
   Account ID.
5. **Guarde essas credenciais também no gerenciador de senhas.** Se a VPS for perdida, o
   `backup.env` vai junto, e são elas que dão acesso aos backups.

### 4.2 healthchecks.io

Crie dois checks:

- `cemed-backup-diario`: período de 1 dia, tolerância de 2 horas.
- `cemed-restore-trimestral`: período de 92 dias, tolerância de 7 dias.

Guarde as duas URLs de ping (`https://hc-ping.com/<uuid>`). Elas também são credenciais.

### 4.3 Chave age (Claude executa, com o Raphael presente)

```bash
sudo apt install age
umask 077; K=$(mktemp /dev/shm/cemed-age.XXXXXX)   # /dev/shm = RAM: shred em ext4 não garante nada
age-keygen -o "$K"                                  # mostra só a pública na tela
echo "teste da chave $(date -u +%FT%TZ)" | age -r "$(age-keygen -y "$K")" > ~/teste-chave.age
# → o Raphael copia o conteúdo de $K (linha AGE-SECRET-KEY-1…) para o gerenciador de senhas
shred -u "$K"; ls -l /dev/shm
# PROVA de que a cópia do gerenciador está certa: colar a chave do gerenciador
age -d -i <(read -rs k; printf '%s\n' "$k") ~/teste-chave.age
```

Recomendado: uma **segunda cópia offline** da chave privada (papel ou cofre). **Perder a
chave é perder todos os backups.**

### 4.4 Credenciais

```bash
install -d -m 700 ~/.config/cemed-backup
install -m 600 scripts/backup/backup.env.example ~/.config/cemed-backup/backup.env
```

**O Raphael preenche** o `backup.env` na VPS. Use o Session pooler, porta 5432 e usuário
`postgres.<ref>`, igual ao `SUPABASE_DB_URL` do `.env` do app. O script recusa o arquivo se a
permissão não for 600 ou se ele tiver chave desconhecida.

### 4.5 Primeiro backup manual

```bash
free -h
bash ~/dev/cemed-chat/scripts/backup/backup.sh
```

Confira três coisas: os 4 arquivos em `daily/<UTC>/` e em `monthly/<mês>/` no painel do R2,
o check `cemed-backup-diario` verde com o corpo de tamanhos, e o domínio respondendo `307`
(nada da produção caiu).

### 4.6 Primeiro teste de restauração

Faça a seção 5 uma vez agora. Ela prova a chave do gerenciador e o caminho inteiro.

### 4.7 Agendamento

Os scripts são chamados **sempre com `bash`**: funciona com ou sem o bit de execução no
checkout (um `git` com `core.fileMode=false` ou uma cópia por zip perde o `+x`).

Rotação do log, no próprio usuário (sem root), em `~/.config/cemed-backup/logrotate.conf`:

```
/home/raphael/.config/cemed-backup/backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  create 0600 raphael raphael
}
```

Linha do crontab (`crontab -e`), uma só, marcada com `# cemed-backup`:

```
15 8 * * * /usr/sbin/logrotate -s /home/raphael/.config/cemed-backup/logrotate.state /home/raphael/.config/cemed-backup/logrotate.conf; flock -n /home/raphael/.config/cemed-backup/cron.lock nice -n 10 ionice -c3 timeout 30m bash /home/raphael/dev/cemed-chat/scripts/backup/backup.sh >> /home/raphael/.config/cemed-backup/backup.log 2>&1 # cemed-backup
```

- **Horário.** O relógio da VPS está em Europe/Berlin, e o `cron` do Ubuntu
  (3.0pl1) não respeita `CRON_TZ`. 08:15 de Berlim = **03:15 BRT** no horário de verão
  europeu e **04:15 BRT** no inverno. As duas caem na faixa de tráfego mínimo (02h–08h BRT
  no log do Caddy) e longe do `kb-conversations-batch` (00:30 BRT).
- **Dois locks.** O `flock` da linha usa `cron.lock`, e o `backup.sh` tem o próprio
  (`backup.lock`). Não use o mesmo arquivo nos dois: o script acharia que já há outro
  backup rodando e sairia sem fazer nada.
- **Desfazer.** `crontab -l | grep -v '# cemed-backup' | crontab -`, ou restaure a cópia
  do crontab feita antes da instalação.
- **Na manhã seguinte:** `tail -n 15 ~/.config/cemed-backup/backup.log` termina com
  `enviado daily/<UTC>`, o R2 tem o conjunto novo em `daily/`, e o `cemed-backup-diario`
  está verde no horário certo.

Antes de dar a instalação por encerrada, crie um lembrete trimestral no calendário
(janeiro, abril, julho e outubro) para o teste da seção 5.

## 5. Teste trimestral de restauração

```bash
bash ~/dev/cemed-chat/scripts/backup/restore-test.sh      # o diário completo mais recente
# ou um conjunto específico:
bash ~/dev/cemed-chat/scripts/backup/restore-test.sh monthly/2026-11/2026-11-01T071500Z
```

O script pede a **chave privada** (cole do gerenciador). Ela não aparece na tela, não vai
para o histórico nem para o disco.

O que acontece:

1. Os 4 cifrados descem do R2. Na máquina só ficam os cifrados.
2. Um contêiner **sem rede** (Postgres 17 + pgvector, os dados em **tmpfs**/RAM) confere o
   sha256 de cada cifrado contra o manifest e decifra.
3. Aplica os roles e as extensões que a produção tinha, e restaura **com donos e grants**.
4. Exige **igualdade** com o manifest em:
   - contagem de linhas de cada tabela;
   - policies e tabelas com RLS;
   - a **lista** de grants efetivos (tabela, função, schema e default privileges);
   - as tabelas no Realtime;
   - cada arquivo de mídia, pelo sha256, mais a cobertura das linhas de `storage.objects`.
5. Pinga `cemed-restore-trimestral`: sucesso com o `RESUMO`, ou `/fail` com as divergências.
6. Descarta o contêiner. O dado restaurado nunca tocou o disco.

Precisa só de `docker`, `curl`, `python3` e `jq` no host (o `age` roda no contêiner), e de
~1,5 GB de RAM livre: o script confere e não começa sem isso.

**Se reprovar, não ignore.** A mensagem diz o que divergiu, por exemplo
`tabela public.x: backup=N restaurado=M` ou `grant só no backup (perdido no restore): …`.
Divergência num backup recente quer dizer que um restore real também sairia errado.

## 6. Desastre: restaurar num projeto Supabase novo

Use quando o projeto atual se perdeu, foi corrompido ou ficou inacessível. O destino é **um
projeto Supabase NOVO** (mesma região, `us-east-2`, Postgres 17), não um Postgres cru: login e
Storage dependem do GoTrue e do Storage do Supabase.

1. **Crie o projeto novo** no painel. Anote a connection string do **Session pooler** (porta
   5432), a URL da API e a `service_role` key.
2. **Credenciais do destino**, num arquivo 600:
   ```bash
   install -m 600 /dev/null ~/.config/cemed-backup/restore-target.env
   # TARGET_DB_URL=postgresql://postgres.<ref-novo>:<senha>@<pooler>:5432/postgres
   # TARGET_SUPABASE_URL=https://<ref-novo>.supabase.co
   # TARGET_SERVICE_ROLE_KEY=...
   ```
   Se a VPS também se perdeu, recrie o `backup.env` noutra máquina com as credenciais do R2
   do gerenciador de senhas (seção 4.1).
3. **Restaure** (pede `RESTAURAR` e a chave privada):
   ```bash
   bash ~/dev/cemed-chat/scripts/backup/restore-supabase.sh  # ou com o PREFIXO do conjunto
   ```
   O script recusa destino que não esteja vazio. Depois:
   - carrega os **dados** de `auth` (usuários, hashes de senha, fatores de MFA);
   - carrega o `public` **inteiro**;
   - carrega os dados de `storage` e as **nossas policies** em `storage.objects`;
   - recoloca as tabelas no `supabase_realtime`;
   - reenvia cada arquivo de mídia pela Storage API no mesmo caminho e com o mimetype original;
   - compara com o manifest.
4. **Troque o projeto no `.env` do app.** São 4 variáveis: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_DB_URL`. Suba
   (topologia A):
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env up -d app worker
   ```
   Confira que o domínio responde `307`.
5. **Troque também no `backup.env`.** Senão o backup diário continua apontando para o projeto
   morto e o alerta dispara.
6. **Reconfigure no painel o que não mora no banco:**
   - Auth: Site URL, Redirect URLs, SMTP, MFA e expiração de JWT;
   - Realtime ligado;
   - limites e e-mails.
7. **Entre com um usuário real.** As senhas vieram, mas as sessões antigas não valem (o JWT
   secret é outro). Todos entram de novo. O MFA continua o mesmo.
8. Rode o `restore-test.sh` no primeiro backup do projeto novo.

O que o script resolve sozinho (provado no ensaio de 2026-10-22, abaixo):

- **Default privileges do Supabase.** O projeto novo dá ALL a `anon`/`authenticated`/
  `service_role` em toda tabela e função que o `postgres` cria em `public`, e o `pg_dump`
  escreve os grants como diferença do padrão do Postgres. Sem tratamento, **todo `REVOKE` da
  produção voltaria aberto**: tabelas e as `security definer` fechadas para `anon` (hoje são
  28 funções). O script tira esses defaults antes de carregar e devolve os de produção no
  fim, pelas entradas do próprio dump.
- **Realtime.** O `pg_dump --schema` não exporta publicações. Sem a filiação, o inbox para de
  atualizar ao vivo; hoje são 9 tabelas, entre elas `messages`, `conversations` e `crm_leads`.
  O manifest registra a filiação e o script a recria.
- **Tabelas internas do Supabase.** `auth.schema_migrations` e `storage.migrations` não são
  copiadas, e só entram dados de tabelas que tinham linhas. Algumas tabelas internas do
  Storage nem aceitam `COPY` do `postgres`.

Limites conhecidos:

- **Versão do GoTrue.** Se o projeto novo estiver numa versão do `auth` que **removeu** uma
  coluna, o COPY falha. Coluna nova não atrapalha. Se isso acontecer, abra chamado no suporte
  do Supabase pedindo a versão anterior, ou ajuste o dump à mão.
- **Dono do objeto.** O reenvio da mídia grava `owner` nulo em `storage.objects`. As nossas
  policies não usam essa coluna.
- **LGPD.** Anonimizações executadas **depois** do backup restaurado não estão nele. Antes
  de reabrir, reexecute as solicitações LGPD atendidas nesse intervalo (registro do
  encarregado / e-mails ao DPO).

### Ensaio local (2026-10-22, Supabase CLI: GoTrue, Storage API e Supavisor reais)

O roteiro foi este:

1. Montar um stack com um usuário criado pelo GoTrue (com senha), mídia enviada pela Storage
   API, uma tabela com RLS e `REVOKE` de `anon`, uma `security definer` fechada para `anon`,
   a tabela no `supabase_realtime` e uma policy nossa em `storage.objects`.
2. Rodar o `backup.sh` pelo Supavisor em session mode.
3. Rodar o `restore-test.sh`: 0 divergências em 38 tabelas, 267 linhas e 924 grants.
4. **Destruir o stack** e subir um novo.
5. Rodar o `restore-supabase.sh` no stack novo.

Resultado no projeto novo:

- o login com a senha original funciona e a senha errada é recusada;
- a mídia baixada pela API é idêntica;
- o usuário restaurado vê só a sua linha (RLS), e `anon` recebe `permission denied`;
- a `security definer` continua fechada para `anon`;
- a tabela está de volta no Realtime e os default privileges são os de produção.

Antes das correções, o mesmo ensaio mostrou `anon` com ALL na tabela e a publicação vazia.

## 7. O que NÃO está no backup

- **Sessão do WhatsApp (WAHA).** Perder significa parear o QR de novo; nenhum dado se perde.
- **`.env` e segredos do app.** Mantenha-os no gerenciador de senhas.
- **Configurações do painel do Supabase** (Auth, SMTP, Realtime): veja o passo 6 da seção 6.
- **Schemas `vault`, `realtime` e `extensions`.** O Vault não é usado pelo código; o
  `realtime` é recriado pelo Supabase.
- **Certificados do Caddy.** O Caddy os renova sozinho.

## 8. Crescimento

Em 2026-10-22, o banco tinha 78 MB (dump de ~10–15 MB/dia) e a mídia, 1 objeto de 75 kB.
São 42 cópias retidas, ~0,6 GB, dentro dos 10 GB grátis do R2. Quando a mídia passar de
~1 GB, troque a cópia diária completa por incremental: só os objetos novos por dia, e a
completa no mensal. O ping de sucesso já traz os tamanhos para acompanhar.

## 9. Decisões e porquês

| Decisão | Por quê |
|---|---|
| Chave privada só no gerenciador | Uma VPS invadida não decifra os backups. O preço é o teste ser semiautomático |
| Teste **trimestral**, vigiado pelo healthchecks | Rodá-lo exige a chave, então é um ritual; o check avisa se for esquecido |
| Session pooler (5432) | IPv4 e grátis, aceita `pg_dump` e é o mesmo do app. A conexão direta só tem IPv6 no Free |
| Bucket lock em vez de versionamento | O R2 não versiona. O lock impede que um token vazado apague backup recente |
| Lock mensal de 90 dias | O lock não encurta depois; aumenta quando a CEMED decidir com o encarregado (LGPD) |
| Contagens no snapshot do dump | O restore exige igualdade exata, não "parecido" |
| Mídia com erro não derruba o banco | Uma mídia quebrada não pode deixar a clínica sem backup do banco |
