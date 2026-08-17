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
# dois lados discordarem -- a pergunta é respondida pelo próprio arquivo que
# vai rodar.
r2_state_needs_credentials() {
    grep -q 'var\.r2_access_key_id' main.tf 2>/dev/null
}

# Descobre o grupo de permissão de ESCRITA de objeto no R2.
#
# Pelo nome, e não por UUID fixo: os ids de permission group não são estáveis
# entre contas, e um UUID errado produz token que a API aceita criar e que não
# escreve nada -- falha três camadas adiante, no PutObject.
r2_write_permission_group_id() {
    local account_id=$1
    curl -sf -X GET "$CF_API/accounts/${account_id}/tokens/permission_groups" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    | jq -r '[.result[]
              | select(.name | test("R2"; "i"))
              | select(.name | test("write|edit"; "i"))
             ] | first | .id // empty'
}

# Cunha o par e exporta. Falha alto: seguir sem credencial faria o apply parar
# depois, com uma mensagem do provider da AWS que não aponta para cá.
r2_mint_ephemeral_credentials() {
    local account_id=$1
    local label=${2:-}

    echo "🔑 ${label} This state writes objects to R2 — minting a short-lived credential..."

    local pg_id
    pg_id=$(r2_write_permission_group_id "$account_id")
    if [ -z "$pg_id" ]; then
        echo "❌ Error: no R2 write permission group is visible to this Cloudflare token." >&2
        echo "   The account token needs 'API Tokens: Edit' to mint credentials, and R2 permissions to grant them." >&2
        return 1
    fi

    # `expires_on` é cinto de segurança, não o mecanismo: quem revoga é o trap
    # do chamador, em minutos. Isto cobre o caso em que o runner morre de um
    # jeito que nem o trap roda (SIGKILL, queda da máquina).
    local expires_on
    expires_on=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%SZ')

    local payload
    payload=$(jq -n \
        --arg name "struct8-r2-${RUN_TAG:-manual}" \
        --arg pg "$pg_id" \
        --arg acc "com.cloudflare.api.account.${account_id}" \
        --arg exp "$expires_on" \
        '{
            name: $name,
            expires_on: $exp,
            policies: [{
                effect: "allow",
                permission_groups: [{ id: $pg }],
                resources: { ($acc): "*" }
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

# Confere que a credencial ASSINA de verdade, contra o endpoint real.
#
# Existe porque as duas formas de errar aqui são silenciosas na criação: a
# derivação do secret e o escopo da permissão. As duas só apareceriam no
# PutObject, dentro do apply, como erro do provider da AWS -- longe da causa.
r2_verify_credentials() {
    local account_id=$1
    local endpoint="https://${account_id}.r2.cloudflarestorage.com"

    if ! command -v aws >/dev/null 2>&1; then
        echo "⚠️  aws CLI not available — skipping the R2 credential check."
        return 0
    fi

    if AWS_PROFILE= \
       AWS_ACCESS_KEY_ID="$TF_VAR_r2_access_key_id" \
       AWS_SECRET_ACCESS_KEY="$TF_VAR_r2_secret_access_key" \
       AWS_REGION=auto \
       aws s3api list-buckets --endpoint-url "$endpoint" >/dev/null 2>&1; then
        echo "✅ R2 credential verified against $endpoint"
        return 0
    fi

    echo "❌ Error: the minted credential does not sign against $endpoint." >&2
    echo "   The token was created, so this is not a permission problem on api.cloudflare.com." >&2
    echo "   Check the R2 permission group granted, and the Access Key derivation in scripts/auth/r2.sh." >&2
    return 1
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
