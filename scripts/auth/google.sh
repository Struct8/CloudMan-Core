#!/bin/bash
# Correção aqui também
source $(dirname "${BASH_SOURCE[0]}")/utils.sh

function auth_google() {
    local auth_json=$1
    echo "🇬 Authenticating Google Cloud (OIDC)..."

    local wif_provider=$(echo "$auth_json" | jq -r '.workload_identity_provider')
    local service_account=$(echo "$auth_json" | jq -r '.service_account')
    
    local audience="//iam.googleapis.com/${wif_provider}"
    local jwt=$(get_github_oidc_token "$audience")
    
    echo "$jwt" > /tmp/oidc_token_google.txt

    cat > /tmp/gcp_auth_config.json <<EOF
{
  "type": "external_account",
  "audience": "${audience}",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "token_url": "https://sts.googleapis.com/v1/token",
  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${service_account}:generateAccessToken",
  "credential_source": {
    "file": "/tmp/oidc_token_google.txt"
  }
}
EOF
    export GOOGLE_APPLICATION_CREDENTIALS="/tmp/gcp_auth_config.json"
}
