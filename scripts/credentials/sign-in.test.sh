#!/usr/bin/env bash
#
# Proves the shell side of the sign-in by `credentials` entries: what
# sign_in_credentials leaves in the state's shell, what it publishes when the
# sign-in is refused, and the copy of the AWS CLI files each state of the old
# path works on (isolate_aws_profiles).
#
# WHY THIS EXISTS. The states of a stage run at the same time, and auth_aws
# wrote every AWS state's account into the one profile `target` of
# ~/.aws/credentials: the last state to sign in decided the account of the
# others. And an export made in a pipe's subshell is lost without an error, so
# the variables of env.sh have to reach the shell that runs Terraform.
#
# HOW. The functions are lifted out of pipeline.sh and run under the engine's
# shell options; node and sign-in.mjs are the real ones. The entries use the
# `secret` method, so nothing here reaches GitHub, AWS, Google or Cloudflare.
# The methods themselves are covered by credentials.test.mjs.
#
# Usage:
#   bash scripts/credentials/sign-in.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE="$HERE/../pipeline.sh"
failures=0

check() {
  local label="$1" expected="$2" got="$3"
  if [ "$expected" == "$got" ]; then
    echo "PASS - $label"
  else
    echo "FAIL - $label"
    echo "         expected: $expected"
    echo "         got:      $got"
    failures=$((failures + 1))
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ------------------------------------------------------------ the functions
# Line endings stripped: a Windows checkout carries CRLF, which bash does not
# read.
LIFTED="credential_root isolate_aws_profiles sign_in_credentials"
for fn in $LIFTED; do
  awk "/^${fn}\\(\\) \\{/{f=1} f{print} f && /^\\}/{exit}" "$PIPELINE" | tr -d '\r' >> "$work/fns.sh"
done
for fn in $LIFTED; do
  check "$fn is defined in pipeline.sh" "1" "$(grep -c "^${fn}() {" "$work/fns.sh")"
done

cat >> "$work/fns.sh" <<'SH'
publish_state_refusal() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$PUBLISHED"; }
SH

export ENGINE_PATH="$HERE/../.."
export RUNNER_TEMP="$work/runner-temp"
export PUBLISHED="$work/published"
CYAN="" NC=""
mkdir -p "$RUNNER_TEMP" "$work/state"

cloudflare_entry() {
  printf '{"id":"cloudflare-%s","provider":"cloudflare","account":"%s","own":%s,"method":"%s","inputs":{"secrets":{"token":"AUTH_CLOUDFLARE_%s"}},"deliver":[{"kind":"env","vars":{"CLOUDFLARE_API_TOKEN":{"from":"token"}}}]}' \
    "$1" "$1" "$2" "$3" "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
}

# ------------------------------------------------------------ signed in
echo "▸ A state signed in by its entries"
out=$(
  cd "$work/state" || exit 1
  set -eo pipefail
  # shellcheck source=/dev/null
  source "$work/fns.sh"
  SECRETS_CONTEXT='{"AUTH_CLOUDFLARE_0A1B2C3D":"cf-token-shell-1"}'
  sign_in_credentials "accounts/cdn" "plan" "[$(cloudflare_entry 0a1b2c3d true secret)]" "[accounts/cdn]" > "$work/log" 2>&1
  printf 'status=%s\n' "$?"
  printf 'token=%s\n' "${CLOUDFLARE_API_TOKEN:-}"
  printf 'value-files=%s\n' "$(find "$RUNNER_TEMP/struct8-cred" -path '*/env/*' -type f | wc -l | tr -d ' ')"
)
check "sign_in_credentials returns 0" "status=0" "$(printf '%s\n' "$out" | grep '^status=')"
check "CLOUDFLARE_API_TOKEN reaches the state's shell" "token=cf-token-shell-1" "$(printf '%s\n' "$out" | grep '^token=')"
check "the files that carried the values are gone" "value-files=0" "$(printf '%s\n' "$out" | grep '^value-files=')"
check "the log masks the token" "1" "$(grep -c '^::add-mask::cf-token-shell-1$' "$work/log")"
check "the token is in no other line of the log" "0" "$(grep -v '^::add-mask::' "$work/log" | grep -c 'cf-token-shell-1')"
check "nothing was published" "no" "$([ -s "$PUBLISHED" ] && echo yes || echo no)"
# Windows keeps no Unix mode, so a Windows checkout cannot prove this one.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) echo "SKIP - the credentials folder is readable by this user only (no Unix modes here)" ;;
  *) check "the credentials folder is readable by this user only" "700" "$(stat -c '%a' "$RUNNER_TEMP/struct8-cred")" ;;
esac

# ------------------------------------------------------------ refused
echo "▸ A state whose entries cannot be used"
rm -f "$PUBLISHED" "$work/state/.struct8-live.log"
out=$(
  cd "$work/state" || exit 1
  set -eo pipefail
  # shellcheck source=/dev/null
  source "$work/fns.sh"
  SECRETS_CONTEXT='{}'
  status=0
  sign_in_credentials "accounts/cdn" "apply" "[$(cloudflare_entry 0a1b2c3d true oidc-oci)]" "[accounts/cdn]" > "$work/log" 2>&1 || status=$?
  printf 'status=%s\n' "$status"
  printf 'token=%s\n' "${CLOUDFLARE_API_TOKEN:-}"
)
live="$work/state/.struct8-live.log"
check "sign_in_credentials returns 1" "status=1" "$(printf '%s\n' "$out" | grep '^status=')"
check "nothing was exported" "token=" "$(printf '%s\n' "$out" | grep '^token=')"
check "the reason starts at an Error: line" "Error: the credentials of this state cannot be used" "$(head -1 "$live" 2>/dev/null)"
check "the reason names the method" "1" "$(grep -c "'oidc-oci', which this engine does not have" "$live" 2>/dev/null)"
check "and ends saying nothing changed" "No resource was changed." "$(tail -1 "$live" 2>/dev/null)"
check "the refusal is published for the state's action" "accounts/cdn apply ./.struct8-live.log" "$(cat "$PUBLISHED" 2>/dev/null)"

echo "▸ A secret the repository does not hold"
rm -f "$PUBLISHED" "$live"
(
  cd "$work/state" || exit 1
  # shellcheck source=/dev/null
  source "$work/fns.sh"
  SECRETS_CONTEXT='{}'
  sign_in_credentials "accounts/cdn" "plan" "[$(cloudflare_entry 0a1b2c3d false secret)]" "[accounts/cdn]" > "$work/log" 2>&1
)
check "the reason names the secret" "Error: secret 'AUTH_CLOUDFLARE_0A1B2C3D' was not found in the repository settings." "$(head -1 "$live" 2>/dev/null)"
check "and the account it belongs to" "1" "$(grep -c 'This state also uses the cloudflare account 0a1b2c3d' "$live" 2>/dev/null)"
check "the refusal is published" "accounts/cdn plan ./.struct8-live.log" "$(cat "$PUBLISHED" 2>/dev/null)"

# ------------------------------------------------------------ AWS copies
echo "▸ Two states of the old path, at the same time"
export HOME="$work/home"
mkdir -p "$HOME/.aws"
printf '[backend]\naws_access_key_id = BACKEND\n' > "$HOME/.aws/credentials"
printf '[profile backend]\nregion = sa-east-1\n' > "$HOME/.aws/config"
unset AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE

sign_in_as() {
  (
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    isolate_aws_profiles || exit 1
    # What `aws configure set ... --profile target` does, in the file the CLI
    # is pointed at.
    printf '[target]\naws_access_key_id = %s\n' "$1" >> "$AWS_SHARED_CREDENTIALS_FILE"
    sleep 1
    printf '%s\n' "$AWS_SHARED_CREDENTIALS_FILE" > "$work/file-$1"
    grep -A1 '^\[target\]' "$AWS_SHARED_CREDENTIALS_FILE" | sed -n 2p > "$work/target-$1"
  )
}
sign_in_as ACCOUNT_A &
sign_in_as ACCOUNT_B &
wait

check "state A reads its own account" "aws_access_key_id = ACCOUNT_A" "$(cat "$work/target-ACCOUNT_A" 2>/dev/null)"
check "state B reads its own account" "aws_access_key_id = ACCOUNT_B" "$(cat "$work/target-ACCOUNT_B" 2>/dev/null)"
check "each state has a file of its own" "no" "$([ "$(cat "$work/file-ACCOUNT_A")" == "$(cat "$work/file-ACCOUNT_B")" ] && echo yes || echo no)"
check "the copy keeps the backend profile" "1" "$(grep -c '^\[backend\]' "$(cat "$work/file-ACCOUNT_A")")"
check "the home file is not changed" "0" "$(grep -c '^\[target\]' "$HOME/.aws/credentials")"
check "the config is copied too" "1" "$(grep -c '^\[profile backend\]' "$(dirname "$(cat "$work/file-ACCOUNT_A")")/config")"

# ------------------------------------------------------------ the wiring
echo "▸ The manifest field reaches run_terraform_process"
plain=$(tr -d '\r' < "$PIPELINE")
check "the scheduler and the stage loop read .credentials" "2" "$(printf '%s\n' "$plain" | grep -c "jq -c '.credentials // \[\]'")"
check "the scheduler passes it" "1" "$(printf '%s\n' "$plain" | grep -c '"${SCH_STATE_RM\[$k\]}" "${SCH_CREDENTIALS\[$k\]}"$')"
check "both calls of the stage loop pass it" "2" "$(printf '%s\n' "$plain" | grep -c '"$traffic" "$state_rm_addresses" "$credentials"')"
check "run_terraform_process takes it as the eighth argument" "1" "$(printf '%s\n' "$plain" | grep -c '^    local credentials_json=${8:-\[\]}$')"

echo
if [ "$failures" -eq 0 ]; then
  echo "All sign-in shell cases pass."
else
  echo "$failures sign-in shell case(s) failed."
fi
[ "$failures" -eq 0 ]
