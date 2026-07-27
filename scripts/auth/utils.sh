#!/bin/bash

function get_github_oidc_token() {
    local aud=$1
    if [ -z "$aud" ]; then aud="sts.amazonaws.com"; fi # Default para AWS

    # Solicita o token ao provedor interno do GitHub Actions
    local token_url="${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${aud}"
    local response=$(curl -s -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "$token_url")
    
    local jwt=$(echo $response | jq -r '.value')
    
    if [ "$jwt" == "null" ] || [ -z "$jwt" ]; then
        echo "❌ Failed to obtain the OIDC token from GitHub." >&2
        return 1
    fi
    echo "$jwt"
}
