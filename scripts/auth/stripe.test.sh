#!/usr/bin/env bash
#
# `auth_stripe` in `stripe.sh`: which secret it reads, which values it refuses,
# and that the key never reaches the output.
#
# WHY THE REFUSALS ARE TESTED: a value that is not a Stripe secret or restricted
# key (a Cloudflare token pasted into the wrong secret, a publishable `pk_` key)
# would otherwise reach the provider, and the run would only say "invalid API
# key" after the plan started, with nothing naming the secret that held it.
#
# WHY THE OUTPUT IS CHECKED: the sign-in prints which secret it read and whether
# the key is a sandbox or a live one. A change that printed the value would put
# the key in the run log of every state that uses Stripe.
#
# Run: bash scripts/auth/stripe.test.sh
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STRIPE="${1:-$HERE/stripe.sh}"

if [ ! -f "$STRIPE" ]; then
  echo "stripe.test: $STRIPE not found"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "stripe.test: jq is required"
  exit 1
fi

# shellcheck source=stripe.sh
source "$STRIPE"

failures=0
ok() { echo "  ok    $1"; }
fail() { failures=$((failures + 1)); echo "  FAIL  $1 -- $2"; }

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

# Runs auth_stripe in a subshell, so nothing it exports leaks into the next
# case. Prints "<exit code>|<STRIPE_API_KEY>|<AUTH_FAILURE_MESSAGE>"; what the
# function printed lands in $OUT.
run_case() {
  local manifest=$1 secrets=$2
  (
    SECRETS_CONTEXT=$secrets
    unset STRIPE_API_KEY
    AUTH_FAILURE_MESSAGE=""
    auth_stripe "$manifest" >"$OUT" 2>&1
    code=$?
    printf '%s|%s|%s' "$code" "${STRIPE_API_KEY:-}" "$AUTH_FAILURE_MESSAGE"
  )
}

# expect <name> <manifest> <secrets> <exit code> <exported key> <text in output or message> <value that must not be printed>
expect() {
  local name=$1 manifest=$2 secrets=$3 want_code=$4 want_key=$5 want_text=$6 secret_value=$7
  local result code key message
  result=$(run_case "$manifest" "$secrets")
  IFS='|' read -r code key message <<<"$result"

  [ "$code" = "$want_code" ] \
    && ok "$name: exit $code" \
    || fail "$name: exit code" "expected $want_code, got $code"
  local key_state=unset
  [ -n "$want_key" ] && key_state=set
  [ "$key" = "$want_key" ] \
    && ok "$name: STRIPE_API_KEY $key_state" \
    || fail "$name: STRIPE_API_KEY" "not the value expected (expected it $key_state)"
  if grep -qF -- "$want_text" "$OUT" || [[ "$message" == *"$want_text"* ]]; then
    ok "$name: says '$want_text'"
  else
    fail "$name: message" "expected '$want_text', output was: $(tr '\n' ' ' <"$OUT")"
  fi
  if [ -n "$secret_value" ] && grep -qF -- "$secret_value" "$OUT"; then
    fail "$name: output" "the secret value was printed"
  else
    ok "$name: the value is not printed"
  fi
}

echo
echo "stripe.sh -- sign-in from the manifest"
echo

expect "secret_name, sandbox restricted key" \
  '{"provider":"stripe","account_id":"acct_1AbC","secret_name":"AUTH_STRIPE_ACCT_1ABC"}' \
  '{"AUTH_STRIPE_ACCT_1ABC":"rk_test_51AbCdEf"}' \
  0 "rk_test_51AbCdEf" "(sandbox)" "rk_test_51AbCdEf"

expect "account_id only (older manifest), live secret key" \
  '{"provider":"stripe","account_id":"ACCT_9"}' \
  '{"AUTH_STRIPE_ACCT_9":"sk_live_9XyZ"}' \
  0 "sk_live_9XyZ" "(live mode)" "sk_live_9XyZ"

expect "no account in the manifest" \
  '{"provider":"stripe"}' \
  '{"AUTH_STRIPE_ACCT_1ABC":"rk_test_51AbCdEf"}' \
  1 "" "names no Stripe account" "rk_test_51AbCdEf"

expect "secret missing from the repository" \
  '{"provider":"stripe","account_id":"acct_2","secret_name":"AUTH_STRIPE_ACCT_2"}' \
  '{"AUTH_STRIPE_ACCT_1ABC":"rk_test_51AbCdEf"}' \
  1 "" "was not found" "rk_test_51AbCdEf"

expect "no secrets passed to the run" \
  '{"provider":"stripe","account_id":"acct_2","secret_name":"AUTH_STRIPE_ACCT_2"}' \
  '' \
  1 "" "was not found" ""

expect "a Cloudflare token in the Stripe secret" \
  '{"provider":"stripe","account_id":"acct_3","secret_name":"AUTH_STRIPE_ACCT_3"}' \
  '{"AUTH_STRIPE_ACCT_3":"cfut_Q1w2E3r4T5y6"}' \
  1 "" "does not hold a Stripe secret or restricted key" "cfut_Q1w2E3r4T5y6"

expect "a publishable key, which cannot write" \
  '{"provider":"stripe","account_id":"acct_4","secret_name":"AUTH_STRIPE_ACCT_4"}' \
  '{"AUTH_STRIPE_ACCT_4":"pk_test_51PuBlIc"}' \
  1 "" "does not hold a Stripe secret or restricted key" "pk_test_51PuBlIc"

echo
if [ "$failures" -eq 0 ]; then
  echo "ALL CASES PASSED"
  exit 0
fi
echo "$failures FAILURE(S)"
exit 1
