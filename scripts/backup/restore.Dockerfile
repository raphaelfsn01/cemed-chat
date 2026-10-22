# Contêiner descartável da restauração: o mesmo Postgres 17 + pgvector do gate de
# CI, com age, jq, curl e python3 mínimo. No teste trimestral (restore-test.sh)
# roda SEM rede; no restore de desastre (restore-supabase.sh) fala só com o
# Supabase novo. Os dados decifrados ficam em tmpfs e somem com o contêiner.
FROM pgvector/pgvector:pg17
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends age jq curl ca-certificates python3-minimal \
 && rm -rf /var/lib/apt/lists/*
