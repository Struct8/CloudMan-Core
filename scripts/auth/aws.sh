#!/bin/bash
source $(dirname "${BASH_SOURCE[0]}")/utils.sh

function auth_aws() {
    local auth_json=$1
    local type=$2 # "backend" ou "target"

    echo "🔶 Autenticando AWS ($type)..."
    
    local role_arn=$(echo "$auth_json" | jq -r '.role_arn')
    local region=$(echo "$auth_json" | jq -r '.region')
    local session_name="CloudMan-${type}"

    local jwt=$(get_github_oidc_token "sts.amazonaws.com")

    local creds=$(aws sts assume-role-with-web-identity \
      --role-arn "$role_arn" \
      --role-session-name "$session_name" \
      --web-identity-token "$jwt" \
      --duration-seconds 900 \
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
