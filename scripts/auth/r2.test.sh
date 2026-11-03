#!/usr/bin/env bash
#
# The two functions in `r2.sh` that read the generated Terraform from disk.
#
# WHY THEY HAVE A TEST AT ALL: both used to read `main.tf` by name, and the
# CloudMan publish stopped writing that file. It now writes one file per domain
# -- `network.tf`, `storage.tf`, `versions.tf` -- so the expression each function
# looks for lands in whichever file its domain owns.
#
# THE FAILURE THAT MADE THIS WORTH GUARDING is not a broken script. Reading
# `main.tf` in a folder that no longer has one simply finds nothing, so
# `r2_state_needs_credentials` answers "no", no credential is minted, and the
# state fails much later at PutObject -- three layers away from the cause, with
# nothing pointing back here. Measured against the previous version of `r2.sh`:
# the split folder answered "no" and the bucket name came back empty.
#
# The legacy shape is covered too. A folder that still holds a single `main.tf`
# has to keep working, because the repositories out there hold both shapes until
# every state is published again.
#
# Run: bash scripts/auth/r2.test.sh
set -u

AQUI=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
R2="${1:-$AQUI/r2.sh}"

if [ ! -f "$R2" ]; then
  echo "r2.test: nao achei $R2"
  exit 1
fi

# Só as duas funções, sem executar o resto do arquivo.
eval "$(sed -n '/^r2_state_needs_credentials()/,/^}/p' "$R2")"
eval "$(sed -n '/^r2_target_bucket()/,/^}/p' "$R2")"

falhas=0
ok() { echo "  ok    $1"; }
falha() { falhas=$((falhas + 1)); echo "  FALHA $1 -- $2"; }

BUCKET_HCL='resource "cloudflare_r2_bucket" "MeuBucket" {
  name = "meu-bucket-real"
}'
OBJETO_HCL='resource "aws_s3_object" "site" {
  bucket = cloudflare_r2_bucket.MeuBucket
  key    = "index.html"
}

provider "aws" {
  access_key = var.r2_access_key_id
}'

cenario() {
  local nome=$1 esperado_precisa=$2 esperado_bucket=$3
  local antes
  antes=$(pwd)
  cd "$dir" || return
  local precisa=nao
  r2_state_needs_credentials && precisa=sim
  local bucket
  bucket=$(r2_target_bucket)
  [ "$precisa" = "$esperado_precisa" ] \
    && ok "$nome: precisa de credencial = $precisa" \
    || falha "$nome: precisa de credencial" "esperava $esperado_precisa, veio $precisa"
  [ "$bucket" = "$esperado_bucket" ] \
    && ok "$nome: bucket = '${bucket}'" \
    || falha "$nome: bucket" "esperava '$esperado_bucket', veio '$bucket'"
  cd "$antes" || return
}

echo
echo "r2.sh -- leitura do Terraform gerado"
echo

# 1. Pasta dividida, com a expressão e o bucket em arquivos DIFERENTES. É o que
#    quebrava: o `grep` de um arquivo só não atravessa domínios.
dir=$(mktemp -d)
printf '%s\n' "$OBJETO_HCL" > "$dir/storage.tf"
printf '%s\n' "$BUCKET_HCL" > "$dir/network.tf"
printf 'terraform {}\n' > "$dir/versions.tf"
cenario "dividida" sim "meu-bucket-real"
rm -rf "$dir"

# 2. Formato antigo, tudo num `main.tf`. Não pode regredir.
dir=$(mktemp -d)
printf '%s\n\n%s\n' "$OBJETO_HCL" "$BUCKET_HCL" > "$dir/main.tf"
cenario "so main.tf" sim "meu-bucket-real"
rm -rf "$dir"

# 3. State que não publica objeto: emitir credencial aqui seria conceder acesso
#    que ninguém pediu.
dir=$(mktemp -d)
printf 'resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n' > "$dir/network.tf"
cenario "sem R2" nao ""
rm -rf "$dir"

# 4. Pasta sem nenhum `.tf`. O glob não expande e chega literal ao grep, o que
#    tem que continuar respondendo "não" em vez de virar erro ou "sim".
dir=$(mktemp -d)
cenario "pasta vazia" nao ""
rm -rf "$dir"

echo
[ "$falhas" -eq 0 ] && echo "Tudo verde." || echo "$falhas falha(s)."
exit $((falhas == 0 ? 0 : 1))
