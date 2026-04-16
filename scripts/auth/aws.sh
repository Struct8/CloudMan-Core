#!/bin/bash
source $(dirname "${BASH_SOURCE[0]}")/utils.sh

function auth_aws() {
    local auth_json=$1
    local type=$2 # "backend" ou "target"

    echo "========================================================="
    echo "🔶 Iniciando Autenticação AWS ($type)..."
    echo "========================================================="
    
    local role_arn=$(echo "$auth_json" | jq -r '.role_arn')
    local region=$(echo "$auth_json" | jq -r '.region')
    local session_name="CloudMan-${type}"

    echo "🔍 [DEBUG] Role ARN Alvo: $role_arn"
    echo "🔍 [DEBUG] Region Alvo: $region"

    # 1. Pega o token através da sua função utilitária
    local jwt=$(get_github_oidc_token "sts.amazonaws.com")

    if [ -z "$jwt" ] || [ "$jwt" == "null" ]; then
        echo "❌ [ERRO CRÍTICO] O Token JWT não foi gerado pela função get_github_oidc_token."
        exit 1
    fi

    # 2. DECODIFICAÇÃO DO TOKEN (Apenas Payload Público) PARA DEBUG
    echo "🔍 [DEBUG OIDC] Decodificando Payload do Token enviado pelo GitHub:"
    local payload=$(echo "$jwt" | awk -F. '{print $2}')
    # Corrige o padding do Base64
    local padding=$((${#payload} % 4))
    if [ $padding -eq 2 ]; then payload="${payload}=="; elif [ $padding -eq 3 ]; then payload="${payload}="; fi
    
    # Imprime o JSON do Token formatado
    echo "$payload" | tr '_-' '/+' | base64 -d | jq . || echo "⚠️ Aviso: Falha ao decodificar log visual do token, mas prosseguindo..."
    echo "---------------------------------------------------------"

    # 3. CHAMADA PARA AWS STS (Capturando erros reais)
    echo "⏳ Solicitando credenciais temporárias ao AWS STS..."
    
    # Executa e guarda o resultado OU o erro na variável 'creds'
    local creds
    creds=$(aws sts assume-role-with-web-identity \
      --role-arn "$role_arn" \
      --role-session-name "$session_name" \
      --web-identity-token "$jwt" \
      --duration-seconds 900 \
      --region "$region" \
      --output json 2>&1)
    
    local sts_status=$?

    if [ $sts_status -ne 0 ]; then
        echo "❌ [ERRO AWS STS] A AWS recusou o token! Retorno da API:"
        echo "$creds"
        echo "========================================================="
        echo "💡 DICA: Compare o campo 'sub' impresso no JSON acima com o 'sub' configurado na AWS."
        exit 1
    fi

    echo "✅ [SUCESSO] Token aceito pela AWS! Extraindo credenciais..."

    # 4. Extração e Configuração
    local key_id=$(echo "$creds" | jq -r '.Credentials.AccessKeyId')
    local secret=$(echo "$creds" | jq -r '.Credentials.SecretAccessKey')
    local token=$(echo "$creds" | jq -r '.Credentials.SessionToken')

    if [ -z "$key_id" ] || [ "$key_id" == "null" ]; then
        echo "❌ [ERRO PARSER] Falha ao extrair AccessKeyId do retorno da AWS."
        exit 1
    fi

    export AWS_ACCESS_KEY_ID="$key_id"
    export AWS_SECRET_ACCESS_KEY="$secret"
    export AWS_SESSION_TOKEN="$token"
    export AWS_REGION="$region"
    
    if [ "$type" == "backend" ]; then
        aws configure set aws_access_key_id "$key_id" --profile backend
        aws configure set aws_secret_access_key "$secret" --profile backend
        aws configure set aws_session_token "$token" --profile backend
        aws configure set region "$region" --profile backend
        echo "🔧 Profile [backend] configurado com sucesso."
    fi
}
