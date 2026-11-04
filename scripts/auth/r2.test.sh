#!/usr/bin/env bash
#
# The two functions in `r2.sh` that read the generated Terraform from disk, and
# the wait for a new credential in `r2_verify_credentials`.
#
# WHY THE FIRST TWO HAVE A TEST AT ALL: both used to read `main.tf` by name, and the
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
# WHY THE WAIT HAS A TEST: `r2_verify_credentials` stopped at the first
# `Unauthorized`, which is what a new token gets, so it never waited. Terraform
# then read the objects with a token the endpoint was still refusing. The test
# puts a fake `aws` on the PATH that plays a list of answers, and a fake `sleep`
# that only moves the clock, so it needs no network and takes no real time.
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
echo "r2.sh -- espera pela credencial nova"
echo

# The numbers come from the file under test, so changing them does not need a
# change here.
eval "$(grep -E '^R2_VERIFY_[A-Z]+=' "$R2")"
REQUIRED=${R2_VERIFY_REQUIRED:-1}
TIMEOUT=${R2_VERIFY_TIMEOUT:-20}
INTERVAL=${R2_VERIFY_INTERVAL:-5}

fake=$(mktemp -d)
mkdir "$fake/bin"
cat > "$fake/bin/aws" <<'FAKE'
#!/usr/bin/env bash
# Plays one line of $R2_FAKE/answers per call, and repeats the last one.
n=$(cat "$R2_FAKE/count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$R2_FAKE/count"
answer=$(sed -n "${n}p" "$R2_FAKE/answers")
[ -n "$answer" ] || answer=$(tail -n 1 "$R2_FAKE/answers")
case "$answer" in
  ok) echo '{"KeyCount": 1}'; exit 0 ;;
  NoSuchBucket) text='The specified bucket does not exist' ;;
  InvalidAccessKeyId) text='The AWS Access Key Id you provided does not exist in our records.' ;;
  *) text=$answer ;;
esac
echo "aws: [ERROR]: An error occurred ($answer) when calling the ListObjectsV2 operation: $text" >&2
exit 254
FAKE
chmod +x "$fake/bin/aws"

# `terraform` wrote these, so the function finds a bucket to probe.
tf=$(mktemp -d)
printf '%s\n\n%s\n' "$OBJETO_HCL" "$BUCKET_HCL" > "$tf/main.tf"

# Runs the check under `set -eo pipefail`, the flags of pipeline.sh, in a subshell
# that keeps the clock and the PATH to itself. `$1` is the list of answers, and
# `$2`, when given, is how many seconds each fake sleep moves the clock.
espera() {
  local salto=${2:-}
  printf '%s\n' $1 > "$fake/answers"
  rm -f "$fake/count"
  saida=$(
    set -eo pipefail
    # shellcheck source=/dev/null
    source "$R2"
    sleep() { SECONDS=$((SECONDS + ${salto:-$1})); }
    export R2_FAKE="$fake" PATH="$fake/bin:$PATH"
    export TF_VAR_r2_access_key_id=key TF_VAR_r2_secret_access_key=secret
    cd "$tf"
    r2_verify_credentials conta
    echo "RETORNOU $?"
  )
  sondas=$(cat "$fake/count" 2>/dev/null || echo 0)
}

confere() {
  local nome=$1 sondas_esperadas=$2 texto=$3
  [ "$sondas" = "$sondas_esperadas" ] \
    && ok "$nome: $sondas sondas" \
    || falha "$nome: sondas" "esperava $sondas_esperadas, veio $sondas"
  case "$saida" in
    *"$texto"*) ok "$nome: disse '$texto'" ;;
    *) falha "$nome: texto" "esperava '$texto' em: $saida" ;;
  esac
  case "$saida" in
    *"RETORNOU 0"*) ok "$nome: nao barrou o pipeline" ;;
    *) falha "$nome: retorno" "a conferencia nao terminou com 0: $saida" ;;
  esac
}

seguidas() {
  local i
  for ((i = 0; i < REQUIRED; i++)); do printf 'ok '; done
}

# 5. The reported case: `Unauthorized` first, then the token starts to work.
espera "Unauthorized Unauthorized $(seguidas)"
confere "Unauthorized e depois sucesso" $((REQUIRED + 2)) "R2 credential verified"

# 6. One good answer is not enough, and a refusal starts the count again. The
#    failed apply had 15 reads accepted and 7 refused in the same two seconds.
espera "ok Unauthorized $(seguidas)"
confere "boa, recusa, boas" $((REQUIRED + 2)) "R2 credential verified"

# 7. Nothing wrong at all: the good answers end it, with no wait announced.
espera "ok"
confere "tudo bom" "$REQUIRED" "R2 credential verified"
case "$saida" in
  *"has not accepted the new credential"*) falha "tudo bom: espera" "anunciou espera sem recusa" ;;
  *) ok "tudo bom: nao anunciou espera" ;;
esac

# 8. The ceiling: it ends, tells what happened, and leaves the decision to
#    Terraform. Commit 3bde70e took this block out of the deploy on purpose.
#    Four jumps reach the ceiling, and the real time of each probe also counts on
#    that clock, so five probes is the most it can take, and more than one proves
#    that it waited.
espera "Unauthorized" $((TIMEOUT / 4))
confere "teto esgotado" "$sondas" "continuing anyway, Terraform decides"
if [ "$sondas" -gt 1 ] && [ "$sondas" -le 5 ]; then
  ok "teto esgotado: esperou e parou no teto"
else
  falha "teto esgotado: sondas" "esperava de 2 a 5, veio $sondas"
fi
case "$saida" in
  *"has not accepted this token"*) ok "teto esgotado: explica Unauthorized" ;;
  *) falha "teto esgotado: explicacao" "texto de Unauthorized desatualizado: $saida" ;;
esac

# 9. The other answer a token the endpoint does not know gets.
espera "InvalidAccessKeyId $(seguidas)"
confere "InvalidAccessKeyId e depois sucesso" $((REQUIRED + 1)) "R2 credential verified"

# 10. Time does not fix these, so the check says so at once.
espera "SignatureDoesNotMatch"
confere "assinatura errada" 1 "continuing anyway, Terraform decides"
espera "AccessDenied"
confere "permissao negada" 1 "continuing anyway, Terraform decides"

# 11. The first apply of a state runs before its bucket exists. Its text also
#     says `does not exist`, which the wait must not read as a token not known yet.
espera "NoSuchBucket"
confere "bucket ainda nao existe" "$REQUIRED" "does not exist yet"

rm -rf "$fake" "$tf"

echo
[ "$falhas" -eq 0 ] && echo "Tudo verde." || echo "$falhas falha(s)."
exit $((falhas == 0 ? 0 : 1))
