#!/bin/bash
#
# Sign-in for a state whose own provider is Stripe.
#
# The app keeps one GitHub secret per Stripe account, AUTH_STRIPE_<account>,
# and names it in the manifest (`secret_name`). The stripe/stripe provider reads
# STRIPE_API_KEY when its block sets no `api_key`, so the key never appears in
# the generated code, the plan file or the log.
#
# A state that only USES Stripe beside its own cloud gets the same variable from
# the `additional_auth` loop in pipeline.sh.

function auth_stripe() {
    local auth_json=$1
    echo "💳 Authenticating Stripe from the manifest..."

    local secret_key=$(echo "$auth_json" | jq -r '.secret_name // empty')
    if [ -z "$secret_key" ]; then
        local acc_id=$(echo "$auth_json" | jq -r '.account_id // empty')
        if [ -z "$acc_id" ]; then
            AUTH_FAILURE_MESSAGE="The manifest names no Stripe account for this state."
            echo "❌ Error: $AUTH_FAILURE_MESSAGE" >&2
            return 1
        fi
        secret_key="AUTH_STRIPE_${acc_id}"
    fi

    echo "🔎 Looking up the secret on GitHub: $secret_key"
    local key_value=$(echo "$SECRETS_CONTEXT" | jq -r --arg key "$secret_key" '.[$key]')

    if [ -z "$key_value" ] || [ "$key_value" == "null" ]; then
        AUTH_FAILURE_MESSAGE="Secret '$secret_key' was not found in the repository settings."
        echo "❌ Error: $AUTH_FAILURE_MESSAGE" >&2
        return 1
    fi

    # A Stripe secret or restricted key, sandbox or live. Anything else is a
    # value pasted into the wrong secret, and the provider would only say
    # "invalid API key" after the plan started.
    if ! [[ "$key_value" =~ ^(sk|rk)_(test|live)_ ]]; then
        AUTH_FAILURE_MESSAGE="Secret '$secret_key' does not hold a Stripe secret or restricted key (sk_ or rk_)."
        echo "❌ Error: $AUTH_FAILURE_MESSAGE" >&2
        return 1
    fi

    export STRIPE_API_KEY="$key_value"
    if [[ "$key_value" =~ ^(sk|rk)_test_ ]]; then
        echo "✅ Stripe key configured (sandbox)."
    else
        echo "✅ Stripe key configured (live mode)."
    fi
}
