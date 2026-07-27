#!/bin/bash
# Correção aqui também
source $(dirname "${BASH_SOURCE[0]}")/utils.sh

function auth_azure() {
    local auth_json=$1
    echo "🔷 Authenticating Azure (OIDC)..."

    local client_id=$(echo "$auth_json" | jq -r '.client_id')
    local tenant_id=$(echo "$auth_json" | jq -r '.tenant_id')
    local subscription_id=$(echo "$auth_json" | jq -r '.subscription_id')

    local jwt=$(get_github_oidc_token "api://AzureADTokenExchange")

    az login --service-principal \
        --username "$client_id" \
        --tenant "$tenant_id" \
        --federated-token "$jwt" \
        --output none

    az account set --subscription "$subscription_id"

    export ARM_CLIENT_ID="$client_id"
    export ARM_SUBSCRIPTION_ID="$subscription_id"
    export ARM_TENANT_ID="$tenant_id"
    export ARM_USE_OIDC="true"
    export ARM_OIDC_TOKEN="$jwt"
}
