#!/bin/bash

function auth_cloudflare() {
    local auth_json=$1
    echo "☁️ Authenticating Cloudflare from the manifest..."

    # 1. Extrai o nome da secret que o Frontend já preparou
    local secret_key=$(echo "$auth_json" | jq -r '.secret_name')

    # Fallback de segurança: se o secret_name não existir (manifesto antigo), 
    # usa o account_id mas avisa que pode dar erro de case
    if [ "$secret_key" == "null" ] || [ -z "$secret_key" ]; then
        local acc_id=$(echo "$auth_json" | jq -r '.account_id')
        secret_key="AUTH_CLOUDFLARE_${acc_id}"
        echo "⚠️  Warning: 'secret_name' missing. Falling back to: $secret_key"
    fi

    echo "🔎 Looking up the secret on GitHub: $secret_key"

    # 2. Busca o valor no contexto de secrets (passado pelo engine.yml)
    local token_value=$(echo "$SECRETS_CONTEXT" | jq -r --arg key "$secret_key" '.[$key]')

    # 3. Validação final
    if [ -z "$token_value" ] || [ "$token_value" == "null" ]; then
        echo "❌ Error: secret '$secret_key' was not found in the repository settings." >&2
        echo "Check that a secret with this exact name exists on GitHub." >&2
        return 1
    fi

    # 4. Configura o Provider
    export CLOUDFLARE_API_TOKEN="$token_value"
    echo "✅ Token configured for the detected key."
}
