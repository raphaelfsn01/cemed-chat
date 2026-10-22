#!/usr/bin/env python3
"""Tar em streaming dos objetos do Supabase Storage, para o stdout (de lá, direto
para o `age`). Nenhum byte de mídia em claro toca o disco nem acumula na memória.

Entrada (stdin): JSON [{"bucket": ..., "name": ..., "size": ...}, ...], lido do
mesmo snapshot do pg_dump. Credencial por ambiente (nunca argv):
SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.

O tar termina com INDICE.json (sha256 e tamanho de cada objeto, os ausentes e os
erros), que o restore usa para conferir arquivo a arquivo. Um objeto que não baixa
NÃO derruba o backup — o banco não pode ficar refém de uma mídia quebrada:
  404 (linha no banco sem arquivo)         → "ausentes"
  401/403/5xx/rede, depois de 3 tentativas → "erros" (o backup.sh sobe tudo e
                                             depois manda /fail com a contagem)
Só aborta se o fluxo quebrar no meio de um arquivo (o tar já estaria corrompido).
Observado no Storage real (backend em disco): arquivo sumido responde 500, não 404.

    python3 -I media-tar.py --summary resumo.json < lista.json | age -r age1... > media.tar.age
"""
import argparse
import hashlib
import io
import json
import os
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

RETRIES = 3


class Falha(Exception):
    """Erro que corrompe o tar: aborta tudo."""


class ErroObjeto(Exception):
    """Um objeto não baixou: registra e segue."""


class LeitorComHash:
    """Repassa a resposta HTTP ao tarfile contando bytes e calculando o sha256."""

    def __init__(self, raw):
        self.raw = raw
        self.sha = hashlib.sha256()
        self.lidos = 0

    def read(self, n=-1):
        bloco = self.raw.read(n)
        self.sha.update(bloco)
        self.lidos += len(bloco)
        return bloco


def ausente(err):
    # O Storage do Supabase responde 404, ou 400 com {"statusCode":"404"} no corpo.
    if err.code == 404:
        return True
    if err.code == 400:
        try:
            return str(json.loads(err.read() or b"{}").get("statusCode")) == "404"
        except ValueError:
            return False
    return False


def abrir(base, chave, bucket, nome):
    url = "%s/storage/v1/object/authenticated/%s/%s" % (
        base.rstrip("/"),
        urllib.parse.quote(bucket, safe=""),
        urllib.parse.quote(nome, safe="/"),
    )
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + chave, "apikey": chave})
    for tentativa in range(1, RETRIES + 1):
        try:
            return urllib.request.urlopen(req, timeout=120)
        except urllib.error.HTTPError as err:
            if ausente(err):
                return None
            if err.code < 500 or tentativa == RETRIES:
                raise ErroObjeto("HTTP %d" % err.code)
        except (urllib.error.URLError, TimeoutError) as err:
            if tentativa == RETRIES:
                raise ErroObjeto("rede: %s" % getattr(err, "reason", err))
        time.sleep(2 * tentativa)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--summary", required=True, help="arquivo de resumo (só contagens, sem dado)")
    args = ap.parse_args()

    base = os.environ["SUPABASE_URL"]
    chave = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    objetos = json.load(sys.stdin)

    indice = {"objetos": [], "ausentes": [], "erros": []}
    total = 0
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        for obj in objetos:
            bucket, nome = obj["bucket"], obj["name"]
            try:
                resp = abrir(base, chave, bucket, nome)
            except ErroObjeto as err:
                print("media-tar: %s/%s não copiado (%s)" % (bucket, nome, err), file=sys.stderr)
                indice["erros"].append({"bucket": bucket, "name": nome, "erro": str(err)})
                continue
            if resp is None:
                indice["ausentes"].append({"bucket": bucket, "name": nome})
                continue
            with resp:
                cl = resp.headers.get("Content-Length")
                tamanho = int(cl) if cl is not None else obj.get("size")
                if tamanho is None:  # nada foi escrito no tar ainda: dá pra pular limpo
                    indice["erros"].append({"bucket": bucket, "name": nome, "erro": "sem tamanho"})
                    continue
                info = tarfile.TarInfo("%s/%s" % (bucket, nome))
                info.size = tamanho
                info.mtime = int(time.time())
                info.mode = 0o600
                leitor = LeitorComHash(resp)
                tar.addfile(info, leitor)  # lê exatamente `tamanho` bytes; menos = OSError
                if resp.read(1):
                    raise Falha("%s/%s maior que o Content-Length" % (bucket, nome))
            total += tamanho
            indice["objetos"].append(
                {"bucket": bucket, "name": nome, "size": tamanho, "sha256": leitor.sha.hexdigest()}
            )

        dados = json.dumps(indice, ensure_ascii=False, indent=1).encode()
        info = tarfile.TarInfo("INDICE.json")
        info.size = len(dados)
        info.mtime = int(time.time())
        tar.addfile(info, io.BytesIO(dados))

    with open(args.summary, "w") as f:
        json.dump({"objetos": len(indice["objetos"]), "bytes": total,
                   "ausentes": len(indice["ausentes"]), "erros": len(indice["erros"])}, f)


if __name__ == "__main__":
    try:
        main()
    except (Falha, OSError, KeyError, ValueError) as err:
        print("media-tar: %s" % err, file=sys.stderr)
        sys.exit(2)
