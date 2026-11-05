#!/bin/bash
#
# Credencial EFÊMERA para escrever objetos no R2.
#
# POR QUE ISTO EXISTE: o R2 tem dois endereços e eles não aceitam a mesma
# autenticação. `api.cloudflare.com` cria bucket, Worker e KV, e usa o Bearer
# que este engine já carrega em CLOUDFLARE_API_TOKEN. Mas o CONTEÚDO dos
# objetos entra por `<conta>.r2.cloudflarestorage.com`, que só aceita
# assinatura SigV4 -- um par access key id + secret. É diferença de FORMATO de
# credencial, não de permissão: nenhum Bearer, por mais amplo que seja, assina
# SigV4.
#
# POR QUE EFÊMERA, E NÃO UMA SECRET FIXA: guardar um par permanente no GitHub
# significa uma credencial com acesso a todo o R2 da conta parada numa gaveta,
# válida para sempre. Aqui ela é cunhada no começo do state, vive na memória do
# runner por alguns minutos e é revogada no fim -- inclusive quando o apply
# falha ou a run é cancelada, porque quem chama arma um `trap ... EXIT`.
#
# ONDE ELA NÃO PASSA: configuração de provider não é persistida no tfstate (ao
# contrário de atributo de recurso), então o segredo não chega ao arquivo de
# estado no S3. E como não existe secret, também não há o que vazar por log de
# outra run.
#
# O par vai para o Terraform como TF_VAR_r2_access_key_id e
# TF_VAR_r2_secret_access_key, que é o nome que o HCL gerado procura -- ver
# handlers/s3Object.ts no CloudMan. Os dois lados têm que concordar nessas duas
# strings.

CF_API="https://api.cloudflare.com/client/v4"

# Id do token cunhado nesta execução. Vazio = nada a revogar, que é o caso da
# esmagadora maioria dos states.
R2_EPHEMERAL_TOKEN_ID=""

# Conta e Bearer usados para CUNHAR, guardados para a revogação usar os mesmos.
#
# Não é zelo abstrato: o bloco de `additional_auth`, logo depois deste ponto no
# pipeline, reexporta CLOUDFLARE_API_TOKEN quando o state alcança outra conta da
# Cloudflare. O trap roda no fim, e sem isto tentaria apagar o token de uma
# conta usando o Bearer de outra.
R2_EPHEMERAL_ACCOUNT=""
R2_EPHEMERAL_CF_TOKEN=""

# Este state precisa escrever objeto no R2?
#
# O gatilho é o HCL GERADO, não um campo do manifesto: o gerador só emite
# `var.r2_access_key_id` quando existe um aws_s3_object apontado para um bucket
# R2. Ler daqui evita um campo novo no manifesto e, principalmente, evita os
# dois lados discordarem -- a pergunta é respondida pelos próprios arquivos que
# vão rodar.
#
# `*.tf`, E NÃO `main.tf`. O CloudMan passou a publicar um arquivo por domínio
# (`network.tf`, `storage.tf`, ...) no lugar de um `main.tf` só, e a expressão
# procurada cai no arquivo do domínio dela. Preso ao nome antigo este grep não
# acharia nada, credencial nenhuma seria emitida, e o apply falharia no
# PutObject -- três camadas adiante de onde está a causa. Pasta que ainda tenha
# só o `main.tf` segue atendida: o glob a alcança igual.
r2_state_needs_credentials() {
    grep -q 'var\.r2_access_key_id' *.tf 2>/dev/null
}

# Descobre o grupo de permissão de ESCRITA de objeto no R2.
#
# Pelo nome, e não por UUID fixo: os ids de permission group não são estáveis
# entre contas, e um UUID errado produz token que a API aceita criar e que não
# escreve nada -- falha três camadas adiante, no PutObject.
# Filtro dos grupos de permissão que servem para escrever OBJETO no R2.
#
# The object groups by their exact names, and not every group with `R2 Storage`
# in the name. That filter also took `Workers R2 Storage Write`, which can create
# and delete any bucket of the account, while a state only reads, writes and
# lists objects. Five groups went into every token, as the run logs show.
#
# Leitura JUNTO da escrita, e não só escrita: o `aws_s3_object` faz HeadObject
# em todo refresh para comparar o etag. Sem leitura, o primeiro `plan` sobre um
# objeto já existente para em AccessDenied.
R2_PG_FILTER='.result[]
  | select(.name == "Workers R2 Storage Bucket Item Read"
        or .name == "Workers R2 Storage Bucket Item Write")'

r2_storage_permission_groups() {
    local account_id=$1
    curl -sf -X GET "$CF_API/accounts/${account_id}/tokens/permission_groups" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
}

# The bucket with this logical name, read from the generated Terraform.
r2_bucket_name() {
    local logico=$1
    awk -v alvo="\"cloudflare_r2_bucket\" \"$logico\"" '
        index($0, alvo) { dentro = 1 }
        dentro && /^[[:space:]]*name[[:space:]]*=/ {
            gsub(/.*=[[:space:]]*"|"[[:space:]]*$/, ""); print; exit
        }
        dentro && /^}/ { exit }
    ' *.tf 2>/dev/null
}

# Every bucket this state reaches through the R2 credential, one name per line.
# It prints nothing when the list cannot be told for certain, because the token is
# limited to this list and a bucket left out is one the state cannot write to.
#
# It reads the blocks that use `aws.r2` and not every `bucket =` of the folder: the
# Terraform backend has a `bucket =` too, and that one is an S3 bucket.
#
# A bucket in a jurisdiction has another resource key, and the endpoint the
# generator writes does not reach it, so that case stays with the wider scope.
r2_state_buckets() {
    if grep -q 'jurisdiction' *.tf 2>/dev/null; then
        return 0
    fi

    local expressions
    expressions=$(awk '
        /^(resource|data|module) / { dentro = 1; alias_r2 = 0; bucket = "?" }
        dentro && /^[[:space:]]*provider[[:space:]]*=[[:space:]]*aws\.r2[[:space:]]*$/ { alias_r2 = 1 }
        dentro && /^[[:space:]]*bucket[[:space:]]*=/ {
            bucket = $0
            sub(/^[^=]*=[[:space:]]*/, "", bucket)
            sub(/[[:space:]]*$/, "", bucket)
        }
        dentro && /^}/ {
            if (alias_r2) print bucket
            dentro = 0
        }
    ' *.tf 2>/dev/null | sort -u)
    [ -n "$expressions" ] || return 0

    local expression name names=""
    while IFS= read -r expression; do
        if ! [[ "$expression" =~ ^cloudflare_r2_bucket\.([A-Za-z0-9_-]+)(\.name)?$ ]]; then
            return 0
        fi
        name=$(r2_bucket_name "${BASH_REMATCH[1]}")
        if ! [[ "$name" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
            return 0
        fi
        names="${names}${name}"$'\n'
    done <<<"$expressions"

    printf '%s' "$names"
}

# The HTTP status of a bucket in the Cloudflare API.
r2_bucket_status() {
    local account_id=$1 bucket=$2
    curl -s -o /dev/null -w '%{http_code}' \
        "$CF_API/accounts/${account_id}/r2/buckets/${bucket}" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
}

# The `resources` of the token, as JSON: the buckets of this state, when all of
# them are known and exist. The other case is every bucket of the account, still
# with object permissions only. The first apply of a state lands there, because
# its bucket does not exist when the token is created, and the Cloudflare
# documentation does not say a token can name a bucket that does not exist yet.
#
# Built with printf and not jq: r2_state_buckets only lets through valid bucket
# names, and this way the tests of this function need no jq.
r2_token_resources() {
    local account_id=$1 buckets bucket json=""
    buckets=$(r2_state_buckets)

    if [ -n "$buckets" ]; then
        while IFS= read -r bucket; do
            if [ "$(r2_bucket_status "$account_id" "$bucket")" != "200" ]; then
                json=""
                break
            fi
            json="${json:+${json},}\"com.cloudflare.edge.r2.bucket.${account_id}_default_${bucket}\":\"*\""
        done <<<"$buckets"
    fi

    if [ -n "$json" ]; then
        echo "{${json}}"
    else
        echo "{\"com.cloudflare.api.account.${account_id}\":{\"com.cloudflare.edge.r2.bucket.*\":\"*\"}}"
    fi
}

# Cunha o par e exporta. Falha alto: seguir sem credencial faria o apply parar
# depois, com uma mensagem do provider da AWS que não aponta para cá.
r2_mint_ephemeral_credentials() {
    local account_id=$1
    local label=${2:-}

    echo "🔑 ${label} This state writes objects to R2 — minting a short-lived credential..."

    local pg_response pg_json pg_names
    pg_response=$(r2_storage_permission_groups "$account_id")
    pg_json=$(echo "$pg_response" | jq -c "[ $R2_PG_FILTER | {id} ]")
    pg_names=$(echo "$pg_response" | jq -r "[ $R2_PG_FILTER | .name ] | join(\", \")")

    if [ "$pg_json" == "[]" ] || [ -z "$pg_json" ]; then
        echo "❌ Error: no R2 Storage permission group is visible to this Cloudflare token." >&2
        echo "   The account token needs 'API Tokens: Edit' to mint credentials, and R2 permissions to grant them." >&2
        echo "   R2-ish groups the account does expose:" >&2
        echo "$pg_response" | jq -r '.result[] | select(.name | test("R2"; "i")) | "     \(.name)"' >&2
        return 1
    fi
    echo "   Permission groups: ${pg_names}"

    # `expires_on` é cinto de segurança, não o mecanismo: quem revoga é o trap
    # do chamador, em minutos. Isto cobre o caso em que o runner morre de um
    # jeito que nem o trap roda (SIGKILL, queda da máquina).
    local expires_on
    expires_on=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ')

    local resources
    resources=$(r2_token_resources "$account_id")
    echo "   Token scope: ${resources}"

    local payload
    payload=$(jq -n \
        --arg name "struct8-r2-${RUN_TAG:-manual}" \
        --argjson pg "$pg_json" \
        --argjson resources "$resources" \
        --arg exp "$expires_on" \
        '{
            name: $name,
            expires_on: $exp,
            policies: [{
                effect: "allow",
                permission_groups: $pg,
                resources: $resources
            }]
        }')

    local response
    response=$(curl -s -X POST "$CF_API/accounts/${account_id}/tokens" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "$payload")

    if [ "$(echo "$response" | jq -r '.success')" != "true" ]; then
        echo "❌ Error: Cloudflare refused to create the R2 credential." >&2
        echo "$response" | jq -r '.errors[]? | "   [\(.code)] \(.message)"' >&2
        echo "   Most likely cause: the account token lacks 'API Tokens: Edit'." >&2
        return 1
    fi

    local token_id token_value
    token_id=$(echo "$response" | jq -r '.result.id')
    token_value=$(echo "$response" | jq -r '.result.value')

    # Regra da Cloudflare para token de R2: o Access Key ID é o ID do token, e o
    # Secret Access Key é o SHA-256 do VALOR do token. Se esta derivação
    # estiver errada, o sintoma é `SignatureDoesNotMatch` no primeiro
    # PutObject -- por isso a conferência logo abaixo, que transforma isso num
    # erro nomeado antes de o Terraform tocar em qualquer coisa.
    local secret
    secret=$(printf '%s' "$token_value" | sha256sum | cut -d' ' -f1)

    R2_EPHEMERAL_TOKEN_ID="$token_id"
    R2_EPHEMERAL_ACCOUNT="$account_id"
    R2_EPHEMERAL_CF_TOKEN="$CLOUDFLARE_API_TOKEN"
    export TF_VAR_r2_access_key_id="$token_id"
    export TF_VAR_r2_secret_access_key="$secret"

    # Mascara no log. O runner só mascara sozinho o que veio de `secrets`, e
    # este valor nasceu aqui dentro.
    echo "::add-mask::$secret"
    echo "::add-mask::$token_value"

    echo "✅ ${label} Credential minted (token ${token_id:0:8}…, revoked at the end of this state)."
}

# Nome real do bucket para onde este state publica.
#
# O HCL referencia o bucket por expressão (`cloudflare_r2_bucket.X.name`), então
# são dois saltos: do objeto para o nome lógico, e do recurso para o `name`.
#
# Os dois saltos varrem `*.tf`, pelo mesmo motivo de `r2_state_needs_credentials`
# -- e podem cair em arquivos DIFERENTES: o objeto vive no domínio dele e o
# bucket no do R2. O `-h` no grep é o que isso exige: com mais de um arquivo o
# grep prefixa cada linha com o nome do arquivo, e o `sed` seguinte devolveria
# `storage.tf:MeuBucket` como nome lógico.
r2_target_bucket() {
    local logico
    logico=$(grep -hoE 'bucket[[:space:]]+= cloudflare_r2_bucket\.[A-Za-z0-9_-]+' *.tf 2>/dev/null \
             | head -1 | sed 's/.*cloudflare_r2_bucket\.//')
    [ -z "$logico" ] && return 0

    r2_bucket_name "$logico"
}

# How long to wait for a new credential. Measured on 58 tokens of MainCDNStruct8,
# from 2026-10-19 to 2026-11-04, in the runs of Struct8/CloudManV2CICD:
#
# - About 1 s after the token was created, 54 of them got `Unauthorized` and 4
#   got a good answer. One good answer proves little: in the run below the same
#   token was accepted and refused within two seconds.
# - Terraform's first read came 17 to 64 s after the token, 26 s at the median.
#   57 runs had no 401. One had 7 of 22 HeadObject refused at 37 s.
#
# Those logs have no sample between 3 and 17 s and only one past 40 s, so these
# numbers are margins, not a measured propagation time. R2_VERIFY_TIMEOUT is about
# three times the latest refusal seen. R2_VERIFY_REQUIRED comes from that 7-in-22
# rate, at which six probes in a row would all pass about one time in ten. The
# timeline this function prints is what will measure the real time.
R2_VERIFY_TIMEOUT=120
R2_VERIFY_INTERVAL=2
R2_VERIFY_REQUIRED=6

# `env -u`, e NÃO `AWS_PROFILE=`. Atribuir vazio não desliga a variável: ela
# continua definida, e o aws-cli sai com
# `The config profile () could not be found` sem nunca chegar ao R2.
#
# AWS_SESSION_TOKEN entra na mesma lista porque o job alcança a conta AWS do
# backend por OIDC: com ele no ambiente, a CLI assina com o par que eu passo
# E manda o session token junto, o que o R2 recusa como
# SignatureDoesNotMatch -- credencial boa, assinatura inválida.
#
# The CLI timeouts keep one hung probe from outliving R2_VERIFY_TIMEOUT.
r2_probe_bucket() {
    local bucket=$1 endpoint=$2
    env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE -u AWS_SESSION_TOKEN \
        AWS_ACCESS_KEY_ID="$TF_VAR_r2_access_key_id" \
        AWS_SECRET_ACCESS_KEY="$TF_VAR_r2_secret_access_key" \
        AWS_REGION=auto AWS_DEFAULT_REGION=auto \
        aws s3api list-objects-v2 --bucket "$bucket" --max-keys 1 \
            --endpoint-url "$endpoint" \
            --cli-connect-timeout 10 --cli-read-timeout 15 2>&1
}

# The error code in an answer of the CLI, such as `Unauthorized`.
r2_answer_code() {
    if [[ "$1" =~ An\ error\ occurred\ \(([A-Za-z]+)\) ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo "error"
    fi
}

# Confere que a credencial ASSINA de verdade, contra o endpoint real.
#
# NÃO BARRA O PIPELINE, e essa foi uma correção aprendida: a primeira versão
# reprovava, e reprovou três vezes seguidas por defeito DELA -- primeiro um
# `AWS_PROFILE=` que nem chegava ao R2, depois uma sonda (`list-buckets`) que é
# operação de CONTA e que um token com escopo de OBJETO não pode executar por
# definição. Uma checagem que produz falso negativo e ainda tranca o deploy
# custa mais do que a ambiguidade que ela evita. Aqui ela informa; quem
# reprova é o Terraform, com o erro da operação de verdade.
r2_verify_credentials() {
    local account_id=$1
    local endpoint="https://${account_id}.r2.cloudflarestorage.com"

    if ! command -v aws >/dev/null 2>&1; then
        echo "⚠️  aws CLI not available — skipping the R2 credential check."
        return 0
    fi

    # A sonda tem que ser uma operação de BUCKET, não de conta: o token existe
    # para escrever objeto, e pedir ListBuckets é pedir o que ele não tem.
    local bucket
    bucket=$(r2_target_bucket)
    if [ -z "$bucket" ]; then
        echo "⚠️  Could not read the target bucket name from the generated Terraform — skipping the R2 credential check."
        return 0
    fi
    echo "   Checking the credential against bucket '${bucket}'..."

    local answer status code elapsed
    local started=$SECONDS good_in_a_row=0 timeline="" last_refusal="" announced=""
    while true; do
        set +e
        answer=$(r2_probe_bucket "$bucket" "$endpoint")
        status=$?
        set -e
        elapsed=$((SECONDS - started))

        if [ $status -eq 0 ]; then
            code="ok"
        else
            code=$(r2_answer_code "$answer")
        fi
        timeline="${timeline} ${elapsed}s:${code}"

        # `Unauthorized` and `InvalidAccessKeyId` are the answers to a token the
        # endpoint does not accept yet, so they are worth waiting for. A wrong
        # signature or a denied permission does not improve with time.
        #
        # `NoSuchBucket` counts as good: the first apply of a state runs before
        # its bucket exists, and that answer means the endpoint got past the
        # credential. That reading is inferred, because none of the measured runs
        # probed a missing bucket. Waiting on it would cost every first apply the
        # whole R2_VERIFY_TIMEOUT.
        case "$code" in
            ok|NoSuchBucket)
                good_in_a_row=$((good_in_a_row + 1))
                ;;
            Unauthorized|InvalidAccessKeyId)
                good_in_a_row=0
                last_refusal=$answer
                if [ -z "$announced" ]; then
                    announced=yes
                    echo "⏳ The R2 endpoint has not accepted the new credential yet (${code}). Waiting up to ${R2_VERIFY_TIMEOUT}s..."
                fi
                ;;
            *)
                good_in_a_row=0
                last_refusal=$answer
                break
                ;;
        esac

        if [ "$good_in_a_row" -ge "$R2_VERIFY_REQUIRED" ]; then
            if [ "$code" = "NoSuchBucket" ]; then
                echo "✅ R2 credential accepted by ${endpoint}; bucket '${bucket}' does not exist yet."
            else
                echo "✅ R2 credential verified against ${endpoint}/${bucket}"
            fi
            echo "   Answers by seconds since the first probe:${timeline}"
            return 0
        fi

        if [ "$elapsed" -ge "$R2_VERIFY_TIMEOUT" ]; then
            break
        fi
        sleep "$R2_VERIFY_INTERVAL"
    done

    # A mensagem da CLI é o diagnóstico, e engoli-la foi o erro da primeira
    # versão: cada código aponta para uma causa DIFERENTE, e sem eles a única
    # saída é adivinhar.
    echo "⚠️  The R2 credential check did not pass — continuing anyway, Terraform decides."
    echo "    Access Key ID used: ${TF_VAR_r2_access_key_id}"
    echo "    Bucket probed: ${bucket}"
    echo "    Answers by seconds since the first probe:${timeline}"
    echo "    Good answers in a row at the end: ${good_in_a_row} of ${R2_VERIFY_REQUIRED}"
    if [ -n "$last_refusal" ]; then
        echo "    Last refusal from the S3 endpoint:"
        echo "$last_refusal" | sed 's/^/      /'
    fi
    echo "    InvalidAccessKeyId    -> the Access Key ID is not the token id"
    echo "    SignatureDoesNotMatch -> the Secret is not SHA-256 of the token value"
    echo "    AccessDenied          -> the token lacks the R2 permission for this bucket"
    echo "    Unauthorized          -> the endpoint has not accepted this token. New tokens get this"
    echo "                             answer at first, and some Terraform reads may get it too."
    echo "                             If they do, run the state again."
    return 0
}

# Revoga. Chamada por trap, então roda no sucesso, na falha e no cancelamento.
#
# Nunca falha o step: neste ponto o apply já aconteceu (ou já falhou por outro
# motivo), e transformar um problema de limpeza em falha do pipeline esconderia
# a causa real. O token expira sozinho em uma hora de qualquer forma.
r2_revoke_ephemeral_credentials() {
    # `if` explícito, e não `[ ... ] && return`: esta função roda por trap, e sob
    # `set -e` o status da última linha do trap vira o status de saída do
    # subshell. Um teste que "falha" por não haver nada a revogar não pode virar
    # falha do state.
    if [ -z "$R2_EPHEMERAL_TOKEN_ID" ]; then
        return 0
    fi

    if curl -sf -X DELETE "$CF_API/accounts/${R2_EPHEMERAL_ACCOUNT}/tokens/${R2_EPHEMERAL_TOKEN_ID}" \
        -H "Authorization: Bearer ${R2_EPHEMERAL_CF_TOKEN}" >/dev/null 2>&1; then
        echo "🧹 R2 credential revoked (token ${R2_EPHEMERAL_TOKEN_ID:0:8}…)."
    else
        echo "⚠️  Could not revoke the R2 credential ${R2_EPHEMERAL_TOKEN_ID:0:8}… — it expires within the hour."
    fi

    unset TF_VAR_r2_access_key_id TF_VAR_r2_secret_access_key
    R2_EPHEMERAL_TOKEN_ID=""
    return 0
}
