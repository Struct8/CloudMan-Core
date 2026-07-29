#!/bin/bash
source $(dirname "${BASH_SOURCE[0]}")/utils.sh

function auth_aws() {
    local auth_json=$1
    local type=$2 # "backend" ou "target"

    echo "🔶 Authenticating AWS ($type)..."
    
    local role_arn=$(echo "$auth_json" | jq -r '.role_arn')
    local region=$(echo "$auth_json" | jq -r '.region')

    # ==========================================================================
    # NOME DA SESSÃO = coluna "User name" do CloudTrail
    # ==========================================================================
    # Era o literal fixo "Struct8-${type}", então TODA ação de TODO cliente
    # aparecia igual no CloudTrail -- sem dizer quem disparou nem de qual run.
    # (Isso custou caro na investigação dos DeleteNatGateway: deu pra ver o quê
    # e quando, mas o "quem" teve que ser correlacionado à mão com a lista de
    # runs do GitHub.)
    #
    # Precedência: usuário do Struct8 (vem do manifest, exportado pelo
    # engine.yml) > ator do GitHub > genérico. Manifesto antigo, sem o campo,
    # simplesmente cai no passo 2 -- nada quebra.
    local raw_actor="${CLOUDMAN_TRIGGERED_BY:-${GITHUB_ACTOR:-CloudMan}}"

    # A sanitização é OBRIGATÓRIA, não cosmética: a AWS só aceita 2-64 chars em
    # [\w+=,.@-]. O username do Cognito tem ESPAÇO ("rmay struct") e conta de app
    # do GitHub tem COLCHETE ("struct8[bot]") -- os dois fazem o assume-role
    # falhar com ValidationError. O '-' fica de fora do conjunto permitido de
    # propósito: é o separador de campo daqui de baixo. O '@' é preservado
    # porque convidado em canvas alheio chega como "convidado@dono".
    #
    # Acento cai fora aqui (vira '.'): "José" -> "Jos.". Quem resolve isso é o
    # frontend, que remove o diacrítico com normalize('NFD') antes de gravar o
    # campo no manifesto -- "José" chega aqui já como "Jose". Tentar consertar
    # no bash foi avaliado e descartado: `iconv //TRANSLIT` devolve "Jos'e" (o
    # apóstrofo vira '.' logo em seguida) e o resultado varia por plataforma.
    local actor="${raw_actor//[^A-Za-z0-9_+=,.@]/.}"
    while [[ "$actor" == *..* ]]; do actor="${actor//../.}"; done
    actor="${actor#.}"; actor="${actor%.}"; actor="${actor:0:48}"
    [ -z "$actor" ] && actor="CloudMan"

    # Sufixo assimétrico: o Event history do CloudTrail lista só MANAGEMENT
    # events, e o profile "backend" (state no S3/DynamoDB) só produz data event
    # -- que não entra ali sem opt-in. Ou seja, na tela aparece sempre "target".
    # Então "target" é o caso implícito e o sufixo só marca o incomum.
    local scope=""
    [ "$type" != "target" ] && scope="-${type}"

    local session_name="${actor}${scope}-gh${GITHUB_RUN_ID:-0}"
    session_name="${session_name:0:64}"

    local jwt=$(get_github_oidc_token "sts.amazonaws.com")

    local creds=$(aws sts assume-role-with-web-identity \
      --role-arn "$role_arn" \
      --role-session-name "$session_name" \
      --web-identity-token "$jwt" \
      --duration-seconds 3600 \
      --region "$region" \
      --output json)

    local key_id=$(echo $creds | jq -r '.Credentials.AccessKeyId')
    local secret=$(echo $creds | jq -r '.Credentials.SecretAccessKey')
    local token=$(echo $creds | jq -r '.Credentials.SessionToken')

    # A SOLUÇÃO: Grava as credenciais em um profile nomeado dinamicamente (backend ou target)
    aws configure set aws_access_key_id "$key_id" --profile "$type"
    aws configure set aws_secret_access_key "$secret" --profile "$type"
    aws configure set aws_session_token "$token" --profile "$type"
    aws configure set region "$region" --profile "$type"

    if [ "$type" == "target" ]; then
        # Força os cloud providers do Terraform a usarem o profile "target"
        export AWS_PROFILE="target"
        export AWS_REGION="$region"
        
        # Garante que as variáveis engessadas não existam para não conflitar 
        # com a comunicação do Backend S3 (que usará o profile "backend")
        unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
    fi
}
