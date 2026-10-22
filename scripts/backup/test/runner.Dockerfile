# Ambiente do teste do backup: o mesmo Ubuntu da VPS (curl 8.5, python 3.12) com
# pg_dump 17 (PGDG) e age. O teste roda o backup.sh AQUI dentro — nada é instalado
# no host para testar.
FROM ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl jq python3 age postgresql-common util-linux \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
