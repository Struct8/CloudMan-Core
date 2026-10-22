#!/usr/bin/env bash
#
# Proves the two things the engine does with what a state holds: signing in to
# a provider the state still uses when the manifest brings no credential for it
# (`sign_in_providers_left_in_state`), and removing resources from a state
# (`remove_from_state`, the `state_rm` action).
#
# WHY THIS EXISTS. On 2026-10-22, 952133486861/CDNMain held a Cloudflare DNS
# record its code no longer declared. Every plan, apply and destroy of that
# state failed with Cloudflare's error 9106, and the way out -- `terraform state
# rm`, or the token -- was out of reach: Terraform runs only on the runner.
#
# HOW. The functions are lifted out of pipeline.sh and run under the engine's
# shell options, inside folders written here. `terraform` is a stub that serves
# a state from a file and logs every call; node and state-entries.mjs are the
# real ones. jq is the real one when the machine has it, otherwise a stand-in
# for the two filters the sign-in uses. The section that builds the published
# file needs the real jq, and says SKIP without it -- a skip is not a pass.
# Nothing here reaches AWS, Cloudflare or GitHub.
#
# Usage:
#   bash scripts/state-rm.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE="$HERE/pipeline.sh"
failures=0
skips=0

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

contains() { case "$2" in *"$1"*) echo yes ;; *) echo no ;; esac; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# ------------------------------------------------------------ the functions
# Line endings stripped: a Windows checkout carries CRLF, which bash does not
# read.
LIFTED="sign_in_providers_left_in_state remove_from_state _refuse_state_rm _publish_state_rm_result publish_engine_artifact"
for fn in $LIFTED; do
  awk "/^${fn}\\(\\) \\{/{f=1} f{print} f && /^\\}/{exit}" "$PIPELINE" | tr -d '\r' >> "$work/fns.sh"
done
for fn in $LIFTED; do
  check "$fn is defined in pipeline.sh" "1" "$(grep -c "^${fn}() {" "$work/fns.sh")"
done
check "the functions find state-entries.mjs where pipeline.sh points" "1" \
  "$(grep -c '^STATE_ENTRIES="\$ENGINE_PATH/scripts/state-entries.mjs"$' <(tr -d '\r' < "$PIPELINE"))"

# ------------------------------------------------------------ terraform stub
cat > "$work/bin/terraform" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_TF_LOG"
case "$1 $2" in
  "state pull")
    if [ "${FAKE_PULL_EXIT:-0}" -ne 0 ]; then
      echo "Error: Failed to load state: AccessDenied" >&2
      exit "$FAKE_PULL_EXIT"
    fi
    cat "$FAKE_STATE"
    ;;
  "state rm")
    if [ "${FAKE_RM_EXIT:-0}" -ne 0 ]; then
      echo "Error: Error acquiring the state lock"
      exit "$FAKE_RM_EXIT"
    fi
    shift 2
    echo "Removed $*"
    ;;
  *)
    echo "the stub does not serve: terraform $*" >&2
    exit 9
    ;;
esac
SH
chmod +x "$work/bin/terraform"

# ------------------------------------------------------------ jq, if missing
if ! command -v jq >/dev/null 2>&1; then
  cat > "$work/bin/jq.js" <<'JS'
// The two filters sign_in_providers_left_in_state runs over SECRETS_CONTEXT,
// and nothing else. Anything other than these exits 3, so a new filter fails
// this test instead of passing it by accident.
const fs = require('fs');
const filter = process.env.JQ_SHIM_FILTER;
const key = process.env.JQ_SHIM_KEY ?? '';
const input = JSON.parse(fs.readFileSync(0, 'utf-8'));
if (filter === 'keys[] | select(ascii_upcase | startswith("AUTH_CLOUDFLARE_"))') {
  for (const k of Object.keys(input).sort()) if (k.toUpperCase().startsWith('AUTH_CLOUDFLARE_')) console.log(k);
} else if (filter === 'first(to_entries[] | select((.key | ascii_upcase) == ($key | ascii_upcase)) | .value) // empty') {
  const hit = Object.entries(input).find(([k]) => k.toUpperCase() === key.toUpperCase());
  if (hit && hit[1] !== null && hit[1] !== false) console.log(hit[1]);
} else {
  console.error('jq stand-in: unsupported filter ' + filter);
  process.exit(3);
}
JS
  cat > "$work/bin/jq" <<'SH'
#!/usr/bin/env bash
filter=""
key=""
while [ $# -gt 0 ]; do
  case "$1" in
    -r) shift ;;
    --arg) [ "$2" == "key" ] && key="$3"; shift 3 ;;
    *) filter="$1"; shift ;;
  esac
done
JQ_SHIM_FILTER="$filter" JQ_SHIM_KEY="$key" exec node "$(dirname "$0")/jq.js"
SH
  chmod +x "$work/bin/jq"
fi

export PATH="$work/bin:$PATH"
export FAKE_TF_LOG="$work/tf.log"

# ------------------------------------------------------------ states
ACCOUNT=bf9638139fc9b9a92fa0334ae15ac3ac
CF='provider[\"registry.terraform.io/cloudflare/cloudflare\"]'
AWS='provider[\"registry.terraform.io/hashicorp/aws\"]'

# The shape of 952133486861/CDNMain on 2026-10-22: the zone, read as data, names
# the account; the record names only the zone.
cat > "$work/cdnmain.json" <<JSON
{"version":4,"serial":161,"lineage":"l-1","resources":[
 {"mode":"data","type":"cloudflare_zone","name":"struct8","provider":"$CF",
  "instances":[{"attributes":{"id":"719dfb57","account":{"id":"$ACCOUNT","name":"x"}}}]},
 {"mode":"managed","type":"cloudflare_dns_record","name":"cname_appb","provider":"$CF",
  "instances":[{"attributes":{"id":"8c3cf338","name":"appb.struct8.com"}}]},
 {"mode":"managed","type":"aws_lambda_function","name":"GetStageV2","provider":"$AWS",
  "instances":[{"attributes":{"id":"GetStageV2"}}]}
]}
JSON

cat > "$work/no-account.json" <<JSON
{"version":4,"serial":7,"lineage":"l-2","resources":[
 {"mode":"managed","type":"cloudflare_dns_record","name":"r","provider":"$CF",
  "instances":[{"attributes":{"id":"rec"}}]}
]}
JSON

cat > "$work/two-accounts.json" <<JSON
{"version":4,"serial":8,"lineage":"l-3","resources":[
 {"mode":"managed","type":"cloudflare_workers_kv_namespace","name":"a","provider":"$CF",
  "instances":[{"attributes":{"id":"a","account_id":"$ACCOUNT"}}]},
 {"mode":"managed","type":"cloudflare_workers_kv_namespace","name":"b","provider":"$CF",
  "instances":[{"attributes":{"id":"b","account_id":"0123456789abcdef0123456789abcdef"}}]}
]}
JSON

cat > "$work/data-only.json" <<JSON
{"version":4,"serial":9,"lineage":"l-4","resources":[
 {"mode":"data","type":"cloudflare_zone","name":"z","provider":"$CF",
  "instances":[{"attributes":{"id":"z","account":{"id":"$ACCOUNT"}}}]}
]}
JSON

LOCK_WITH_CF='provider "registry.terraform.io/cloudflare/cloudflare" {
  version = "5.28.1"
}
provider "registry.terraform.io/hashicorp/aws" {
  version = "6.20.0"
}'
LOCK_AWS_ONLY='provider "registry.terraform.io/hashicorp/aws" {
  version = "6.20.0"
}'

new_case() {
  local dir="$work/case$RANDOM$RANDOM"
  mkdir -p "$dir"
  : > "$FAKE_TF_LOG"
  echo "$dir"
}

# ================================================================ sign-in
#
# Runs the function in a folder with the given lock file and state, under the
# engine's options, and prints the token it left exported (or NONE), then its
# output.
sign_in() {
  local state="$1" lock="$2" secrets="$3" preset="${4:-}"
  local dir
  dir=$(new_case)
  [ -n "$lock" ] && printf '%s\n' "$lock" > "$dir/.terraform.lock.hcl"
  (
    set -eo pipefail
    cd "$dir"
    export FAKE_STATE="$state"
    YELLOW='' NC=''
    STATE_ENTRIES="$HERE/state-entries.mjs"
    SECRETS_CONTEXT="$secrets"
    if [ -n "$preset" ]; then export CLOUDFLARE_API_TOKEN="$preset"; else unset CLOUDFLARE_API_TOKEN; fi
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    # Called in THIS shell, output to a file: inside `$(...)` it would run in a
    # subshell, and the export under test would die with it.
    status=0
    sign_in_providers_left_in_state "[952133486861/CDNMain]" > "$dir/.out" 2>&1 || status=$?
    echo "TOKEN=${CLOUDFLARE_API_TOKEN:-NONE}"
    if [ $status -ne 0 ]; then echo "RETURNED_NONZERO"; fi
    cat "$dir/.out"
  ) 2>&1
}

SECRETS_ONE="{\"github_token\":\"gh\",\"AUTH_CLOUDFLARE_BF9638139FC9B9A92FA0334AE15AC3AC\":\"cf-token-1\"}"
SECRETS_TWO="{\"AUTH_CLOUDFLARE_BF9638139FC9B9A92FA0334AE15AC3AC\":\"cf-token-1\",\"AUTH_CLOUDFLARE_0123456789ABCDEF0123456789ABCDEF\":\"cf-token-2\"}"
SECRETS_NONE="{\"github_token\":\"gh\"}"

r=$(sign_in "$work/cdnmain.json" "$LOCK_WITH_CF" "$SECRETS_ONE")
check "the CDNMain case: the token of the account the zone names is exported" "yes" "$(contains 'TOKEN=cf-token-1' "$r")"
check "and the log names the resource that needed it" "yes" "$(contains 'cloudflare_dns_record.cname_appb' "$r")"
check "and the secret it used, never the token" "yes/no" \
  "$(contains 'AUTH_CLOUDFLARE_BF9638139FC9B9A92FA0334AE15AC3AC' "$r")/$(printf '%s' "$r" | grep -v '^TOKEN=' | grep -q 'cf-token-1' && echo yes || echo no)"

r=$(sign_in "$work/cdnmain.json" "$LOCK_WITH_CF" "$SECRETS_ONE" "from-the-manifest")
check "a token the manifest already brought is kept" "yes" "$(contains 'TOKEN=from-the-manifest' "$r")"
check "and the state is not read for it" "0" "$(grep -c 'state pull' "$FAKE_TF_LOG")"

r=$(sign_in "$work/cdnmain.json" "$LOCK_AWS_ONLY" "$SECRETS_ONE")
check "no Cloudflare in the lock file: nothing is exported" "yes" "$(contains 'TOKEN=NONE' "$r")"
check "and the state is not read" "0" "$(grep -c 'state pull' "$FAKE_TF_LOG")"

r=$(sign_in "$work/cdnmain.json" "" "$SECRETS_ONE")
check "no lock file at all: nothing is exported" "yes" "$(contains 'TOKEN=NONE' "$r")"

r=$(sign_in "$work/no-account.json" "$LOCK_WITH_CF" "$SECRETS_ONE")
check "a state that names no account takes the repository's one Cloudflare secret" "yes" "$(contains 'TOKEN=cf-token-1' "$r")"

r=$(sign_in "$work/no-account.json" "$LOCK_WITH_CF" "$SECRETS_TWO")
check "with two Cloudflare secrets and no account in the state, nothing is exported" "yes" "$(contains 'TOKEN=NONE' "$r")"
check "and the warning says why" "yes" "$(contains 'does not hold exactly one AUTH_CLOUDFLARE_ secret' "$r")"

r=$(sign_in "$work/two-accounts.json" "$LOCK_WITH_CF" "$SECRETS_TWO")
check "resources of two accounts: nothing is exported -- one token signs in to one" "yes" "$(contains 'TOKEN=NONE' "$r")"
check "and the warning names both" "yes" "$(contains "2 Cloudflare accounts" "$r")"

r=$(sign_in "$work/cdnmain.json" "$LOCK_WITH_CF" "$SECRETS_NONE")
check "the account's secret is not in the repository: nothing is exported" "yes" "$(contains 'TOKEN=NONE' "$r")"
check "and the warning names the secret it looked for" "yes" \
  "$(contains 'has no secret AUTH_CLOUDFLARE_BF9638139FC9B9A92FA0334AE15AC3AC' "$r")"

r=$(sign_in "$work/data-only.json" "$LOCK_WITH_CF" "$SECRETS_ONE")
check "only data sources of Cloudflare: nothing to reach, nothing exported, nothing said" "TOKEN=NONE" "$(printf '%s' "$r" | grep -v '^$')"

r=$(FAKE_PULL_EXIT=1 sign_in "$work/cdnmain.json" "$LOCK_WITH_CF" "$SECRETS_ONE")
check "a state that cannot be read exports nothing" "yes" "$(contains 'TOKEN=NONE' "$r")"
check "and the function never fails the run, in any case above" "no" "$(contains 'RETURNED_NONZERO' "$r")"

# ================================================================ removal
#
# The publishers are recorders here: the failure file's content is the job of
# `_publish_failure_file`, already in use by every action, and the result file
# has a section of its own below.
removal() {
  local state="$1" requested="$2"
  local dir
  dir=$(new_case)
  (
    set -eo pipefail
    cd "$dir"
    export FAKE_STATE="$state"
    GREEN='' RED='' NC=''
    STATE_ENTRIES="$HERE/state-entries.mjs"
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    publish_state_rm_failure() {
      echo "PUBLISHED_FAILURE stage=$2"
      echo "--- log"
      cat "$3"
      echo "---"
    }
    _publish_state_rm_result() {
      echo "PUBLISHED_RESULT before=$4 after=$5"
      echo "REMOVED $(cat "$2")"
    }
    state_object_version() {
      if [ -f .version-taken ]; then printf 'v-after'; else : > .version-taken; printf 'v-before'; fi
    }
    run_tf_with_stale_lock_recovery() {
      local status=0
      "$@" > ./.struct8-live.log 2>&1 || status=$?
      cat ./.struct8-live.log
      return $status
    }
    status=0
    remove_from_state "952133486861/CDNMain" "$requested" "[952133486861/CDNMain]" || status=$?
    echo "STATUS=$status"
    echo "LEFT_BEHIND=$(ls -A | grep -v '^\.version-taken$' | grep -v '^\.struct8-live\.log$' | paste -sd, -)"
  ) 2>&1
}

RECORD="cloudflare_dns_record.cname_appb"

r=$(removal "$work/cdnmain.json" "$RECORD")
check "the CDNMain record is removed: the run succeeds" "yes" "$(contains 'STATUS=0' "$r")"
check "terraform state rm runs with the lock, and -- before the address" "1" \
  "$(grep -cx "state rm -lock=true -- $RECORD" "$FAKE_TF_LOG")"
check "the result goes out with the object version before and after" "yes" \
  "$(contains 'PUBLISHED_RESULT before=v-before after=v-after' "$r")"
check "and names what was removed, with its id" "yes" \
  "$(contains '"address":"cloudflare_dns_record.cname_appb","mode":"managed","type":"cloudflare_dns_record","provider":"registry.terraform.io/cloudflare/cloudflare","id":"8c3cf338"' "$r")"
check "the serial before the removal goes with it" "yes" "$(contains '"serial":161' "$r")"
check "no file is left in the state's folder" "yes" "$(printf '%s' "$r" | grep -qx 'LEFT_BEHIND=' && echo yes || echo no)"
check "the state's own cloud is never signed in to: terraform saw only state commands" "0" \
  "$(grep -vcE '^state (pull|rm)( |$)' "$FAKE_TF_LOG")"

r=$(removal "$work/cdnmain.json" "$(printf '%s\n%s\n' "$RECORD" "aws_s3_bucket.gone")")
check "one address that names nothing: the run fails" "yes" "$(contains 'STATUS=1' "$r")"
check "and NOTHING is removed, the address that exists included" "0" "$(grep -c 'state rm' "$FAKE_TF_LOG")"
check "the refusal is published as a request problem" "yes" "$(contains 'PUBLISHED_FAILURE stage=request' "$r")"
check "it starts at an Error: line, where the failure file begins reading" "yes" \
  "$(printf '%s' "$r" | sed -n '/^--- log$/{n;p;}' | grep -q '^Error: ' && echo yes || echo no)"
check "and lists the address that named nothing" "yes" "$(contains '  - aws_s3_bucket.gone' "$r")"
check "and not the one that did" "no" "$(printf '%s' "$r" | sed -n '/^--- log$/,/^---$/p' | grep -q -- "- $RECORD" && echo yes || echo no)"

r=$(removal "$work/cdnmain.json" "-state=/tmp/other.tfstate")
check "an address shaped like a flag is refused before Terraform sees it" "yes/0" \
  "$(contains 'PUBLISHED_FAILURE stage=request' "$r")/$(grep -c 'state rm' "$FAKE_TF_LOG")"

r=$(removal "$work/cdnmain.json" "")
check "no address at all: the run fails" "yes" "$(contains 'STATUS=1' "$r")"
check "and the state is not even read" "0" "$(grep -c 'state' "$FAKE_TF_LOG")"
check "the refusal says nothing was named" "yes" "$(contains 'Error: no resource named to remove from the state' "$r")"

r=$(FAKE_RM_EXIT=1 removal "$work/cdnmain.json" "$RECORD")
check "terraform state rm fails: the run fails" "yes" "$(contains 'STATUS=1' "$r")"
check "the failure is published from Terraform's own log" "yes/yes" \
  "$(contains 'PUBLISHED_FAILURE stage=state_rm' "$r")/$(contains 'Error acquiring the state lock' "$r")"
check "and no result claims a removal" "no" "$(contains 'PUBLISHED_RESULT' "$r")"
check "nor is a file left behind" "yes" "$(printf '%s' "$r" | grep -qx 'LEFT_BEHIND=' && echo yes || echo no)"

r=$(FAKE_PULL_EXIT=1 removal "$work/cdnmain.json" "$RECORD")
check "the state cannot be read: the run fails" "yes" "$(contains 'STATUS=1' "$r")"
check "published as a read problem, with Terraform's reason" "yes/yes" \
  "$(contains 'PUBLISHED_FAILURE stage=read' "$r")/$(contains 'AccessDenied' "$r")"
check "and nothing is removed" "0" "$(grep -c 'state rm' "$FAKE_TF_LOG")"

# ================================================================ the result file
#
# Needs the real jq: the file is assembled by it, as every file the engine
# publishes is.
if command -v jq >/dev/null 2>&1 && jq --version >/dev/null 2>&1 && [ ! -x "$work/bin/jq.js" ] && [ ! -f "$work/bin/jq.js" ]; then
  dir=$(new_case)
  (
    cd "$dir"
    export RUNNER_TEMP="$dir/runner"
    GREEN='' RED='' NC=''
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    node "$HERE/state-entries.mjs" resolve "$RECORD" < "$work/cdnmain.json" > removed.json
    echo '{"serial":162,"lineage":"l-1","resources":[{"address":"aws_lambda_function.GetStageV2","mode":"managed","type":"aws_lambda_function","provider":"registry.terraform.io/hashicorp/aws","id":"GetStageV2"}]}' > after.json
    _publish_state_rm_result "952133486861/CDNMain" removed.json after.json "v1" ""
  ) > "$work/publish.out" 2>&1
  published="$dir/runner/struct8-artifacts/952133486861__CDNMain.state_rm_result.json.gz"
  check "the result is handed to the publish step under the state's name" "yes" "$([ -f "$published" ] && echo yes || echo no)"
  if [ -f "$published" ]; then
    body=$(gunzip -c "$published")
    check "it says what happened" "state_rm/succeeded" "$(jq -r '.cloudman_result | "\(.action)/\(.outcome)"' <<< "$body")"
    check "what was removed" "cloudflare_dns_record.cname_appb" "$(jq -r '.removed[].address' <<< "$body")"
    check "the serials on each side" "161/162" "$(jq -r '"\(.state_before.serial)/\(.state_after.serial)"' <<< "$body")"
    check "the version to restore, and null where the bucket gave none" "v1/null" \
      "$(jq -r '"\(.state_before.object_version)/\(.state_after.object_version)"' <<< "$body")"
    check "and what the state holds now" "aws_lambda_function.GetStageV2" "$(jq -r '.resources[].address' <<< "$body")"
  fi
  dir=$(new_case)
  (
    cd "$dir"
    export RUNNER_TEMP="$dir/runner"
    GREEN='' RED='' NC=''
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    node "$HERE/state-entries.mjs" resolve "$RECORD" < "$work/cdnmain.json" > removed.json
    : > after.json
    _publish_state_rm_result "952133486861/CDNMain" removed.json after.json "" ""
  ) > /dev/null 2>&1
  published="$dir/runner/struct8-artifacts/952133486861__CDNMain.state_rm_result.json.gz"
  check "an unreadable list of what is left still publishes the removal" "cloudflare_dns_record.cname_appb/null" \
    "$( [ -f "$published" ] && gunzip -c "$published" | jq -r '"\(.removed[].address)/\(.resources)"')"
else
  echo "SKIP - the result file needs the real jq, which this machine does not have"
  skips=$((skips + 1))
fi

echo ""
if [ $failures -eq 0 ]; then
  if [ $skips -gt 0 ]; then
    echo "ALL CASES RUN PASSED ($skips section skipped)"
  else
    echo "ALL CASES PASSED"
  fi
  exit 0
fi
echo "$failures CASE(S) FAILED"
exit 1
