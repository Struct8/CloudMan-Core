#!/usr/bin/env bash
#
# Proves how the engine tells the app which provider configurations a state
# still uses: each state writes the list when it ends (`record_state_providers`),
# and the progress report that closes the state carries it
# (`report_state_progress`).
#
# WHY THIS EXISTS. Terraform refuses to plan, apply or destroy a managed
# resource whose aliased provider configuration is gone from the code
# ("Provider configuration not present", measured with Terraform 1.5.7 on
# 2026-11-15). The app writes the block of another account only while the
# diagram uses that account, so the run that should destroy the account's last
# resource stops. With this list, the app keeps the block until the state no
# longer uses it.
#
# HOW. The functions are lifted out of pipeline.sh and run under the engine's
# shell options, inside folders written here. `terraform` is a stub that serves
# a state from a file and logs every call; `curl` is a stub that answers the
# token request and keeps the body of the report; node and state-entries.mjs
# are the real ones. jq is the real one when the machine has it, otherwise a
# stand-in for the filters report_state_progress runs. Nothing here reaches
# GitHub or the Struct8 Worker.
#
# Usage:
#   bash scripts/state-providers.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIPELINE="$HERE/pipeline.sh"
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
mkdir -p "$work/bin"

# ------------------------------------------------------------ the functions
# Line endings stripped: a Windows checkout carries CRLF, which bash does not
# read.
PIPELINE_LF="$work/pipeline.sh"
tr -d '\r' < "$PIPELINE" > "$PIPELINE_LF"
LIFTED="state_providers_file record_state_providers report_state_progress"
for fn in $LIFTED; do
  awk "/^${fn}\\(\\) \\{/{f=1} f{print} f && /^\\}/{exit}" "$PIPELINE_LF" >> "$work/fns.sh"
done
for fn in $LIFTED; do
  check "$fn is defined in pipeline.sh" "1" "$(grep -c "^${fn}() {" "$work/fns.sh")"
done
check "the list lives under RUNNER_TEMP, which GitHub empties at every job" "1" \
  "$(grep -c '^STATE_PROVIDERS_DIR="${RUNNER_TEMP:-/tmp}/struct8-state-providers"$' "$PIPELINE_LF")"

# ------------------------------------------------------------ the wiring
# Where pipeline.sh calls record_state_providers. The trap is what makes a
# failed apply write the list too, and the R2 sign-in replaces the trap of the
# subshell, so it has to keep the call.
subshell_start=$(grep -n '^        cd "\$path" || { echo -e "\${RED}❌ ERROR: folder not found: \$path\${NC}"; exit 1; }$' "$PIPELINE_LF" | cut -d: -f1)
trap_line=$(grep -n "^        trap 'record_state_providers \"\$path\" \"\$action\"' EXIT$" "$PIPELINE_LF" | cut -d: -f1)
check "the state's subshell arms the trap right after it enters the folder" "yes" \
  "$([ -n "$subshell_start" ] && [ -n "$trap_line" ] && [ $((trap_line - subshell_start)) -le 6 ] && echo yes || echo no)"
check "the R2 sign-in keeps the call in the trap it arms" "1" \
  "$(grep -c "trap 'r2_revoke_ephemeral_credentials; record_state_providers \"\$path\" \"\$action\"' EXIT" "$PIPELINE_LF")"
check "no other trap in pipeline.sh drops the call" "0" \
  "$(grep -E '^\s*trap ' "$PIPELINE_LF" | grep ' EXIT' | grep -vc 'record_state_providers\|rm -f\|rm -rf')"
destroy_record=$(grep -n '^              record_state_providers "\$path" "\$action"$' "$PIPELINE_LF" | cut -d: -f1)
destroy_cleanup=$(grep -n '^              rm -rf .terraform terraform.tfstate terraform.tfstate.backup .terraform.lock.hcl$' "$PIPELINE_LF" | cut -d: -f1)
check "a destroy writes the list before it removes the local cache the read needs" "yes" \
  "$([ -n "$destroy_record" ] && [ -n "$destroy_cleanup" ] && [ "$destroy_record" -lt "$destroy_cleanup" ] && echo yes || echo no)"

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
  *)
    echo "the stub does not serve: terraform $*" >&2
    exit 9
    ;;
esac
SH
chmod +x "$work/bin/terraform"

# ------------------------------------------------------------ curl stub
# The token request answers a token; the report keeps its body and answers the
# status code that FAKE_POST_CODE names.
cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
body=""
post=0
while [ $# -gt 0 ]; do
  case "$1" in
    -X) [ "$2" == "POST" ] && post=1; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    -H|-m|-o|-w) shift 2 ;;
    *) shift ;;
  esac
done
if [ "$post" -eq 1 ]; then
  printf '%s' "$body" > "$FAKE_POST_BODY"
  printf '%s' "${FAKE_POST_CODE:-200}"
else
  printf '{"value":"fake-token"}'
fi
SH
chmod +x "$work/bin/curl"

# ------------------------------------------------------------ jq, if missing
if ! command -v jq >/dev/null 2>&1; then
  cat > "$work/bin/jq.js" <<'JS'
// The filters report_state_progress runs, and nothing else. Anything other
// than these exits 3, so a new filter fails this test instead of passing it by
// accident.
const fs = require('fs');
const args = process.argv.slice(2);
let filter = null;
const vars = {};
let compact = false;
let raw = false;
let nullInput = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-c') compact = true;
  else if (a === '-r') raw = true;
  else if (a === '-n') nullInput = true;
  else if (a === '--arg') { vars[args[i + 1]] = args[i + 2]; i += 2; }
  else if (a === '--argjson') { vars[args[i + 1]] = JSON.parse(args[i + 2]); i += 2; }
  else if (a === '--slurpfile') { vars[args[i + 1]] = [JSON.parse(fs.readFileSync(args[i + 2], 'utf-8'))]; i += 2; }
  else filter = a;
}
const input = nullInput ? null : JSON.parse(fs.readFileSync(0, 'utf-8'));
const print = (v) => process.stdout.write((compact ? JSON.stringify(v) : JSON.stringify(v, null, 2)) + '\n');
const squashed = (filter ?? '').replace(/\s+/g, ' ').trim();
if (squashed === '.value // empty') {
  if (input && input.value) process.stdout.write((raw ? input.value : JSON.stringify(input.value)) + '\n');
} else if (squashed === '{ state: $state, status: $status, index: $index, total: $total }') {
  print({ state: vars.state, status: vars.status, index: vars.index, total: vars.total });
} else if (squashed === '. + { providers: $list[0].providers }') {
  print({ ...input, providers: vars.list[0].providers });
} else {
  console.error('jq stand-in: unsupported filter ' + filter);
  process.exit(3);
}
JS
  cat > "$work/bin/jq" <<'SH'
#!/usr/bin/env bash
exec node "$(dirname "$0")/jq.js" "$@"
SH
  chmod +x "$work/bin/jq"
fi

export PATH="$work/bin:$PATH"
export FAKE_TF_LOG="$work/tf.log"
export FAKE_POST_BODY="$work/body.json"
export STATE_ENTRIES="$HERE/state-entries.mjs"
export RUNNER_TEMP="$work/runner-temp"
mkdir -p "$RUNNER_TEMP"

# Runs one lifted function the way the engine does: under `set -eo pipefail`,
# with the definitions that sit at the top of pipeline.sh.
in_engine() {
  (
    set -eo pipefail
    STATE_PROVIDERS_DIR="${RUNNER_TEMP}/struct8-state-providers"
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    "$@"
  )
}

# ------------------------------------------------------------ states
GOOGLE='provider[\"registry.terraform.io/hashicorp/google\"]'
AWS='provider[\"registry.terraform.io/hashicorp/aws\"]'

# The shape of stateAwsDnsTarget after F2 stage 1: the zone of another project
# read as data, the validation record written in it, and the certificate in the
# state's own account.
cat > "$work/dns-target.json" <<JSON
{"version":4,"serial":12,"lineage":"l-1","resources":[
 {"mode":"data","type":"google_dns_managed_zone","name":"zone","provider":"$GOOGLE.acct_deft_landing_343414",
  "instances":[{"attributes":{"id":"projects/deft-landing-343414/managedZones/site"}}]},
 {"mode":"managed","type":"google_dns_record_set","name":"validation","provider":"$GOOGLE.acct_deft_landing_343414",
  "instances":[{"attributes":{"id":"rec","rrdatas":["s3cr3t-value"]}}]},
 {"mode":"managed","type":"aws_acm_certificate","name":"site","provider":"$AWS",
  "instances":[{"attributes":{"id":"arn:aws:acm:us-east-1:952133486861:certificate/x","private_key":"s3cr3t-value"}}]}
]}
JSON
: > "$work/empty.json"

new_state_dir() {
  local dir="$work/states/$1"
  mkdir -p "$dir"
  [ "${2:-init}" == "init" ] && mkdir -p "$dir/.terraform"
  printf '%s' "$dir"
}

# ------------------------------------------------------------ the file name
check "a state in a folder gets the folder's name, with the slashes flattened" \
  "$RUNNER_TEMP/struct8-state-providers/envs__prod.json" "$(in_engine state_providers_file ./envs/prod/)"
check "a state at the root of the repository gets _root" \
  "$RUNNER_TEMP/struct8-state-providers/_root.json" "$(in_engine state_providers_file .)"

# ------------------------------------------------------------ record_state_providers
dir=$(new_state_dir apply)
: > "$FAKE_TF_LOG"
(cd "$dir" && FAKE_STATE="$work/dns-target.json" in_engine record_state_providers ./apply apply)
file="$RUNNER_TEMP/struct8-state-providers/apply.json"
check "an apply writes the list" "yes" "$([ -s "$file" ] && echo yes || echo no)"
check "the list names the aliased configuration of the record and the default one of the certificate, and not the data source alone" \
  "registry.terraform.io/hashicorp/aws:-:1 registry.terraform.io/hashicorp/google:acct_deft_landing_343414:1" \
  "$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).providers;console.log(p.map(r=>`${r.source}:${r.alias??"-"}:${r.resources}`).join(" "))' "$file")"
check "no attribute value of the state reaches the list" "0" "$(grep -c 's3cr3t-value' "$file")"
check "the state is read once, by state pull" "state pull" "$(cat "$FAKE_TF_LOG")"
check "nothing is left in the state's folder" "" "$(ls -A "$dir" | grep -v '^\.terraform$' || true)"

for action in scan read import traffic; do
  dir=$(new_state_dir "action-$action")
  : > "$FAKE_TF_LOG"
  (cd "$dir" && FAKE_STATE="$work/dns-target.json" in_engine record_state_providers "./action-$action" "$action")
  check "the $action action writes no list and does not read the state" "no:" \
    "$([ -e "$RUNNER_TEMP/struct8-state-providers/action-$action.json" ] && echo yes || echo no):$(cat "$FAKE_TF_LOG")"
done

dir=$(new_state_dir before-init no-init)
: > "$FAKE_TF_LOG"
(cd "$dir" && FAKE_STATE="$work/dns-target.json" in_engine record_state_providers ./before-init plan)
check "a state that stopped before init writes no list and does not read the state" "no:" \
  "$([ -e "$RUNNER_TEMP/struct8-state-providers/before-init.json" ] && echo yes || echo no):$(cat "$FAKE_TF_LOG")"

dir=$(new_state_dir pull-fails)
file="$RUNNER_TEMP/struct8-state-providers/pull-fails.json"
printf '%s' '{"providers":[{"source":"earlier","alias":null,"resources":1,"addresses":["x.y"]}]}' > "$file"
(cd "$dir" && FAKE_STATE="$work/dns-target.json" FAKE_PULL_EXIT=1 in_engine record_state_providers ./pull-fails apply)
status=$?
check "a read that fails does not fail the run" "0" "$status"
check "and keeps the list an earlier read wrote, instead of an empty one" "earlier" \
  "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).providers[0].source)' "$file")"
check "and leaves no temporary file" "no" "$([ -e "${file}.tmp" ] && echo yes || echo no)"

dir=$(new_state_dir destroyed)
(cd "$dir" && FAKE_STATE="$work/empty.json" in_engine record_state_providers ./destroyed destroy)
check "a destroyed state, whose read prints nothing, writes an empty list" '{"providers":[]}' \
  "$(tr -d '\r\n' < "$RUNNER_TEMP/struct8-state-providers/destroyed.json")"

# ------------------------------------------------------------ report_state_progress
export PROGRESS_URL="https://struct8.test/webhooks/engine-progress"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://token.test/?x=1"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="request-token"
export SOURCES_FILE=""

file="$RUNNER_TEMP/struct8-state-providers/apply.json"
rm -f "$FAKE_POST_BODY"
in_engine report_state_progress ./apply running 1 2
check "the report that opens a state carries no list" "no" \
  "$(node -e 'console.log("providers" in JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"))?"yes":"no")' "$FAKE_POST_BODY")"
check "and keeps the file for the report that closes it" "yes" "$([ -s "$file" ] && echo yes || echo no)"

expected=$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).providers))' "$file")
FAKE_POST_CODE=500 in_engine report_state_progress ./apply ok 1 2
check "a report the Worker did not take keeps the file" "yes" "$([ -s "$file" ] && echo yes || echo no)"
rm -f "$FAKE_POST_BODY"
in_engine report_state_progress ./apply ok 1 2
check "the report that closes a state carries the list it wrote" "$expected" \
  "$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).providers))' "$FAKE_POST_BODY")"
check "next to the fields the report always had" "./apply:ok:1:2" \
  "$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log([b.state,b.status,b.index,b.total].join(":"))' "$FAKE_POST_BODY")"
check "and drops the file once the Worker took it" "no" "$([ -e "$file" ] && echo yes || echo no)"

rm -f "$FAKE_POST_BODY"
in_engine report_state_progress ./before-init failed 2 2
check "a state that wrote no list reports without the field, so the app keeps the list it has" "no" \
  "$(node -e 'console.log("providers" in JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"))?"yes":"no")' "$FAKE_POST_BODY")"

echo
if [ "$failures" -eq 0 ]; then
  echo "ALL CASES PASSED"
  exit 0
fi
echo "$failures CASE(S) FAILED"
exit 1
