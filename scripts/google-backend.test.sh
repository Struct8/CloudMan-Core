#!/usr/bin/env bash
#
# Proves the Google Cloud sign-in and the gcs backend support of the engine:
# the credential file auth_google writes, the token exchange it checks the file
# with, what init hands each backend, where the backend sign-in goes, and the
# release of a gcs lock left by a cancelled run.
#
# WHY THIS EXISTS. The previous credential file held the GitHub token itself,
# which expires in 5 minutes, so the Google libraries could not renew the
# one-hour access token and an apply longer than an hour lost its credential.
# The backend sign-in was always AWS, so a state kept in Cloud Storage could not
# run at all.
#
# HOW. scripts/auth/google.sh and scripts/release-locks.sh run as they are, and
# the functions under test are lifted out of pipeline.sh. curl is replaced by a
# stub that logs every call and answers from a table each case writes; nothing
# here reaches Google, GitHub or AWS. jq is the real one when the machine has
# it, otherwise a stand-in that covers only the filters these scripts use.
#
# Usage:
#   bash scripts/google-backend.test.sh

# Not `set -u`: the engine runs without it, and the code under test is the
# engine's.
set -o pipefail

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

contains() { case "$2" in *"$1"*) echo yes ;; *) echo no ;; esac; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ------------------------------------------------------------ the engine copy
# Line endings stripped: a Windows checkout carries CRLF, which bash does not
# read.
mkdir -p "$work/engine/scripts/auth" "$work/bin"
tr -d '\r' < "$HERE/auth/google.sh" > "$work/engine/scripts/auth/google.sh"
tr -d '\r' < "$HERE/release-locks.sh" > "$work/engine/scripts/release-locks.sh"
for fn in remote_backend_names backend_init_args authenticate_backend; do
  awk "/^${fn}\\(\\) \\{/{f=1} f{print} f && /^\\}/{exit}" "$PIPELINE" | tr -d '\r' >> "$work/pipeline-fns.sh"
done
for fn in remote_backend_names backend_init_args authenticate_backend; do
  check "$fn is defined in pipeline.sh" "1" "$(grep -c "^${fn}() {" "$work/pipeline-fns.sh")"
done

# ------------------------------------------------------------ jq, if missing
if ! command -v jq >/dev/null 2>&1; then
  cat > "$work/bin/jq.js" <<'JS'
// The jq filters these scripts use, and nothing else: alternatives (`//`),
// `empty`, string literals, and paths of `.name`, `.name?` and `[]`.
const fs = require('fs');
let raw = false, compact = false;
const rest = [];
for (const a of process.argv.slice(2)) {
  if (/^-[rc]+$/.test(a)) { raw ||= a.includes('r'); compact ||= a.includes('c'); }
  else rest.push(a);
}
const filter = process.env.JQ_SHIM_FILTER;
const text = fs.readFileSync(0, 'utf8');
if (text.trim() === '') process.exit(0);
let input;
try { input = JSON.parse(text); } catch { console.error('jq stand-in: invalid JSON'); process.exit(2); }

function path(expr, value) {
  if (expr === '.') return [value];
  let outs = [value];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)\??|\[\]/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < expr.length && (m = re.exec(expr))) {
    if (m[0] === '[]') outs = outs.flatMap(v => v == null ? [] : Array.isArray(v) ? v : Object.values(v));
    else outs = outs.map(v => (v !== null && typeof v === 'object' && !Array.isArray(v)) ? (v[m[1]] ?? null) : null);
  }
  if (re.lastIndex !== expr.length) { console.error('jq stand-in: unsupported filter ' + filter); process.exit(3); }
  return outs;
}
function term(t) {
  if (t === 'empty') return [];
  if (/^".*"$/.test(t)) return [JSON.parse(t)];
  return path(t, input);
}
const terms = filter.split('//').map(t => t.trim());
let result = [];
for (let i = 0; i < terms.length; i++) {
  const outs = term(terms[i]);
  if (i === terms.length - 1) { result = outs; break; }
  const kept = outs.filter(v => v !== null && v !== false);
  if (kept.length) { result = kept; break; }
}
for (const v of result) {
  process.stdout.write((raw && typeof v === 'string' ? v : JSON.stringify(v, null, compact ? 0 : 2)) + '\n');
}
JS
  cat > "$work/bin/jq" <<'SH'
#!/usr/bin/env bash
# The filter travels in the environment and the file through stdin, so the
# Windows path rewriting of command-line arguments never touches either.
flags=()
filter=""
file=""
for a in "$@"; do
  case "$a" in
    -*) flags+=("$a") ;;
    *) if [ -z "$filter" ]; then filter="$a"; else file="$a"; fi ;;
  esac
done
if [ -n "$file" ]; then
  JQ_SHIM_FILTER="$filter" exec node "$(dirname "$0")/jq.js" "${flags[@]}" < "$file"
fi
JQ_SHIM_FILTER="$filter" exec node "$(dirname "$0")/jq.js" "${flags[@]}"
SH
  chmod +x "$work/bin/jq"
fi

# ------------------------------------------------------------ curl and aws
cat > "$work/bin/curl" <<'SH'
#!/usr/bin/env bash
# Logs the call and answers from the respond() the current case wrote. What
# came from a file is logged as H@[...] or D@[...], what came on the command
# line as H[...] or D[...]: that is how a case tells whether a secret showed in
# the runner's process list.
method=GET out="" url="" extra=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -w|--max-time) shift 2 ;;
    -H) if [[ "$2" == @* ]]; then extra+=" H@[$(tr -d '\n' < "${2#@}")]"; else extra+=" H[$2]"; fi; shift 2 ;;
    --data-urlencode)
      if [[ "$2" =~ ^[A-Za-z_]+@ ]]; then extra+=" D@[${2%%@*}=$(cat "${2#*@}")]"; else extra+=" D[$2]"; fi
      shift 2 ;;
    --data-binary) extra+=" B[$(cat "${2#@}")]"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s %s%s\n' "$method" "$url" "$extra" >> "$STUB_DIR/calls"
CODE=000 BODY=""
source "$STUB_DIR/respond.sh"
respond "$method" "$url"
[ -n "$out" ] && printf '%s' "$BODY" > "$out"
printf '%s' "$CODE"
SH
cat > "$work/bin/aws" <<'SH'
#!/usr/bin/env bash
echo "aws $*" >> "$STUB_DIR/calls"
echo '{}'
SH
chmod +x "$work/bin/curl" "$work/bin/aws"

export PATH="$work/bin:$PATH"
export STUB_DIR="$work/stub"
mkdir -p "$STUB_DIR"

# respond_with <case arms>: the arms come before the default token chain, so a
# case overrides one step by naming it.
respond_with() {
  {
    echo 'respond() {'
    echo '  case "$1 $2" in'
    printf '%s\n' "$1"
    cat <<'ARMS'
    "GET https://token.actions.example/"*) CODE=200; BODY='{"value":"gh-jwt"}' ;;
    "POST https://sts.googleapis.com/v1/token") CODE=200; BODY='{"access_token":"federated"}' ;;
    "POST https://iamcredentials.googleapis.com/"*) CODE=200; BODY='{"accessToken":"sa-token"}' ;;
    *) CODE=404; BODY='{"error":{"message":"no route in the stub"}}' ;;
ARMS
    echo '  esac'
    echo '}'
  } > "$STUB_DIR/respond.sh"
  : > "$STUB_DIR/calls"
}

# The JSON field <dotted.path> of <file>, read by node.
field() {
  node -e 'let j=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k], j); process.stdout.write(v===undefined?"<missing>":String(v))' "$2" < "$1"
}

export RUNNER_TEMP="$work/runner-temp"
export ACTIONS_ID_TOKEN_REQUEST_URL="https://token.actions.example/idtoken?api-version=2.0"
export ACTIONS_ID_TOKEN_REQUEST_TOKEN="request.token-1_2"
PROVIDER="projects/123456789/locations/global/workloadIdentityPools/struct8-github/providers/gh-42"
SA="struct8-gh-42@customer-proj.iam.gserviceaccount.com"
AUTH="{\"workload_identity_provider\":\"$PROVIDER\",\"service_account\":\"$SA\"}"
ENCODED_AUDIENCE="https%3A%2F%2Fiam.googleapis.com%2Fprojects%2F123456789%2Flocations%2Fglobal%2FworkloadIdentityPools%2Fstruct8-github%2Fproviders%2Fgh-42"

# shellcheck source=/dev/null
source "$work/engine/scripts/auth/google.sh"

# ------------------------------------------------------------ encoding
check "a query value is percent-encoded" "https%3A%2F%2Fiam.googleapis.com%2Fp%2F1%20x" \
  "$(google_urlencode 'https://iam.googleapis.com/p/1 x')"

# ------------------------------------------------------------ target sign-in
respond_with ''
unset GOOGLE_APPLICATION_CREDENTIALS
export GOOGLE_CREDENTIALS="left-on-the-runner"
auth_google "$AUTH" target > /dev/null
check "the target sign-in succeeds" "0" "$?"
target_file="${GOOGLE_APPLICATION_CREDENTIALS:-}"
check "the target exports a credential file under RUNNER_TEMP" "yes" \
  "$([[ "$target_file" == "$RUNNER_TEMP/struct8-gcp/target-"*.json ]] && [ -f "$target_file" ] && echo yes || echo no)"
check "a GOOGLE_CREDENTIALS left on the runner is cleared, since it would win over the file" "" "${GOOGLE_CREDENTIALS:-}"

check "the file is an external_account credential" "external_account" "$(field "$target_file" type)"
check "its audience is the provider" "//iam.googleapis.com/$PROVIDER" "$(field "$target_file" audience)"
check "it impersonates the service account" \
  "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$SA:generateAccessToken" \
  "$(field "$target_file" service_account_impersonation_url)"
check "the GitHub token is requested from a URL, so the libraries can renew it" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$ENCODED_AUDIENCE" "$(field "$target_file" credential_source.url)"
check "the token request carries the job's bearer" "Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$(field "$target_file" credential_source.headers.Authorization)"
check "the token is read from the 'value' field of GitHub's answer" "value" \
  "$(field "$target_file" credential_source.format.subject_token_field_name)"
check "no token is written to disk" "<missing>" "$(field "$target_file" credential_source.file)"

calls="$(cat "$STUB_DIR/calls")"
check "the check asks GitHub for a token with the job's bearer" "yes" \
  "$(contains "GET $ACTIONS_ID_TOKEN_REQUEST_URL&audience=$ENCODED_AUDIENCE H@[Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN]" "$calls")"
check "the check trades GitHub's token at STS for the provider" "yes" \
  "$(contains "D[audience=//iam.googleapis.com/$PROVIDER]" "$calls")"
check "the subject token is GitHub's, read from a file" "yes" "$(contains "D@[subject_token=gh-jwt]" "$calls")"
check "the check impersonates with the federated token" "yes" \
  "$(contains "POST https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$SA:generateAccessToken H@[Authorization: Bearer federated]" "$calls")"
check "no Authorization header travels on a command line" "no" "$(contains "H[Authorization" "$calls")"

# ------------------------------------------------------------ backend sign-in
respond_with ''
unset GOOGLE_APPLICATION_CREDENTIALS
auth_google "{\"workload_identity_provider\":\"//iam.googleapis.com/$PROVIDER\",\"service_account\":\"$SA\"}" backend > /dev/null
check "the backend sign-in succeeds" "0" "$?"
backend_file="$RUNNER_TEMP/struct8-gcp/backend.json"
check "the backend file has its own name" "yes" "$([ -f "$backend_file" ] && echo yes || echo no)"
check "the backend sign-in exports nothing: init hands the file to the backend" "" "${GOOGLE_APPLICATION_CREDENTIALS:-}"
check "a provider given with the //iam.googleapis.com/ prefix gives the same audience" \
  "//iam.googleapis.com/$PROVIDER" "$(field "$backend_file" audience)"

# ------------------------------------------------------------ refusals
refusal() {  # refusal <auth json> -> "<status>|<message>"
  AUTH_FAILURE_MESSAGE=""
  auth_google "$1" target > /dev/null
  printf '%s|%s' "$?" "$AUTH_FAILURE_MESSAGE"
}

got="$(refusal "{\"workload_identity_provider\":\"projects/customer-proj/locations/global/workloadIdentityPools/p/providers/q\",\"service_account\":\"$SA\"}")"
check "a provider named by project ID is refused" "1" "${got%%|*}"
check "the refusal says the project goes by its number" "yes" "$(contains "the project's number, not its ID" "$got")"
check "the refusal starts at an Error: line" "yes" "$(contains "|Error: the workload identity provider for this state" "$got")"

got="$(refusal "{\"workload_identity_provider\":\"$PROVIDER\"}")"
check "a missing service account is refused" "1|Error: no Google Cloud sign-in for this state" "$(head -n1 <<< "$got")"

got="$(refusal "{\"workload_identity_provider\":\"$PROVIDER\",\"service_account\":\"someone@gmail.com\"}")"
check "an address that is not a service account is refused" "1" "${got%%|*}"

got="$(ACTIONS_ID_TOKEN_REQUEST_URL='' refusal "$AUTH")"
check "a job without id-token: write is refused, naming the permission" "yes" "$(contains "id-token: write" "$got")"

got="$(ACTIONS_ID_TOKEN_REQUEST_TOKEN='a"b' refusal "$AUTH")"
check "a request token that would break the JSON is refused" "yes" "$(contains "unexpected format" "$got")"

respond_with '    "POST https://sts.googleapis.com/v1/token") CODE=400; BODY='"'"'{"error":"unauthorized_client","error_description":"The given credential is rejected by the attribute condition."}'"'"' ;;'
got="$(refusal "$AUTH")"
check "a token the provider rejects fails the sign-in" "1" "${got%%|*}"
check "the failure names the service account" "yes" "$(contains "Error: could not sign in to Google Cloud as $SA" "$got")"
check "the failure carries STS's reason" "yes" "$(contains "rejected by the attribute condition. (HTTP 400)" "$got")"
check "the failure points at the attribute condition" "yes" "$(contains "Its attribute condition has to accept" "$got")"
check "no impersonation is tried after STS refuses" "no" "$(contains "iamcredentials" "$(cat "$STUB_DIR/calls")")"

respond_with '    "POST https://iamcredentials.googleapis.com/"*) CODE=403; BODY='"'"'{"error":{"code":403,"message":"Permission iam.serviceAccounts.getAccessToken denied on resource","status":"PERMISSION_DENIED"}}'"'"' ;;'
got="$(refusal "$AUTH")"
check "a service account that refuses fails the sign-in" "1" "${got%%|*}"
check "the failure carries IAM's reason" "yes" "$(contains "iam.serviceAccounts.getAccessToken denied on resource (HTTP 403)" "$got")"
check "the failure names the role the principal needs" "yes" "$(contains "Workload Identity User role" "$got")"

respond_with '    "GET https://token.actions.example/"*) CODE=403; BODY='"'"'{"message":"no"}'"'"' ;;'
got="$(refusal "$AUTH")"
check "GitHub refusing the token fails the sign-in" "yes" "$(contains "GitHub did not issue an OIDC token to this job (HTTP 403)" "$got")"

# ------------------------------------------------------------ gcs object names
check "an empty prefix" "default.tflock" "$(gcs_object_name "" tflock)"
check "a prefix as the Google generator writes it" "states/app/default.tfstate" "$(gcs_object_name "states/app" tfstate)"
check "leading and trailing slashes" "a/b/default.tflock" "$(gcs_object_name "/a/b/" tflock)"
check "repeated slashes collapse, as path.Join does" "a/b/default.tflock" "$(gcs_object_name "a//b" tflock)"
check "the object goes into the URL as one segment" \
  "https://storage.googleapis.com/storage/v1/b/tfstate-b/o/states%2Fapp%2Fdefault.tflock" \
  "$(gcs_object_url tfstate-b states/app/default.tflock)"

# ------------------------------------------------------------ init arguments
# shellcheck source=/dev/null
source "$work/pipeline-fns.sh"
export BACKEND_REGION="us-east-1"

init_args_in() {  # init_args_in <backend type> <workspace provider> -> status, args, output
  local dir="$work/state$RANDOM$RANDOM"
  mkdir -p "$dir"
  printf 'terraform {\n  backend "%s" {\n  }\n}\n' "$1" > "$dir/main.tf"
  (
    cd "$dir" || exit 9
    BACKEND_PROVIDER="$2"
    out="$(backend_init_args 2>&1; echo "status=$?")"
    backend_init_args > /dev/null 2>&1
    printf '%s\nargs=%s\n' "$out" "${BACKEND_INIT_ARGS[*]}"
  )
}

got="$(init_args_in gcs google)"
check "gcs under a Cloud Storage workspace: init gets the backend file" \
  "args=-backend-config=credentials=$backend_file" "$(grep '^args=' <<< "$got")"
check "and passes" "status=0" "$(grep '^status=' <<< "$got")"

got="$(init_args_in s3 aws)"
check "s3 under an S3 workspace: the AWS profile, as before" \
  "args=-backend-config=profile=backend -backend-config=region=us-east-1" "$(grep '^args=' <<< "$got")"

got="$(init_args_in gcs aws)"
check "gcs under an S3 workspace is refused" "status=1" "$(grep '^status=' <<< "$got")"
check "the refusal starts at an Error: line" "Error: the state's backend does not match the GitOps Workspace" "$(head -n1 <<< "$got")"
check "it names where the code keeps the state" "yes" "$(contains 'in Cloud Storage (backend "gcs"),' "$got")"
check "and where the workspace keeps them" "yes" "$(contains 'keeps its states in Amazon S3. Nothing ran.' "$got")"
check "and gives no arguments" "args=" "$(grep '^args=' <<< "$got")"

got="$(init_args_in s3 google)"
check "s3 under a Cloud Storage workspace is refused" "yes" "$(contains 'keeps its states in Cloud Storage. Nothing ran.' "$got")"

got="$(init_args_in azurerm aws)"
check "a backend the engine does not open is refused by name" 'Error: the engine cannot open the backend "azurerm"' "$(head -n1 <<< "$got")"

mv "$backend_file" "$backend_file.kept"
printf 'Error: could not sign in to Google Cloud as %s\n\nreason\n' "$SA" > "$RUNNER_TEMP/struct8-gcp/backend.error"
got="$(init_args_in gcs google)"
check "with no backend file, the state refuses with the sign-in's reason" "Error: could not sign in to Google Cloud as $SA" "$(head -n1 <<< "$got")"
check "and says nothing ran" "yes" "$(contains "Nothing ran." "$got")"
rm -f "$RUNNER_TEMP/struct8-gcp/backend.error"
got="$(init_args_in gcs google)"
check "with no file and no reason written down, a refusal still starts at Error:" \
  "Error: no Google Cloud sign-in for the bucket that holds the states" "$(head -n1 <<< "$got")"
mv "$backend_file.kept" "$backend_file"

# ------------------------------------------------------------ backend sign-in dispatch
dispatch() {  # dispatch <workspace provider> <auth_google status> -> calls, status
  (
    : > "$work/dispatch.calls"
    auth_aws() { echo "auth_aws $2 $1" >> "$work/dispatch.calls"; }
    debug_auth_status() { :; }
    auth_google() {
      echo "auth_google $2 $1" >> "$work/dispatch.calls"
      [ "$GOOGLE_STUB_STATUS" == "0" ] && return 0
      AUTH_FAILURE_MESSAGE="Error: stub refusal"
      return 1
    }
    BACKEND_PROVIDER="$1" GOOGLE_STUB_STATUS="$2" BACKEND_ROLE="arn:aws:iam::1:role/r" BACKEND_REGION="us-east-1"
    authenticate_backend '{"provider":"google","bucket":"b"}' > /dev/null
    echo "status=$?"
    cat "$work/dispatch.calls"
  )
}

got="$(dispatch aws 0)"
check "an S3 workspace signs in to AWS as before" "yes" "$(contains 'auth_aws backend {"role_arn": "arn:aws:iam::1:role/r", "region": "us-east-1"}' "$got")"
check "and not to Google" "no" "$(contains "auth_google" "$got")"

got="$(dispatch google 0)"
check "a Cloud Storage workspace signs in to Google, with the workspace's JSON" "yes" \
  "$(contains 'auth_google backend {"provider":"google","bucket":"b"}' "$got")"
check "and not to AWS" "no" "$(contains "auth_aws" "$got")"

cp "$backend_file" "$backend_file.kept"
got="$(dispatch google 1)"
check "a failed Google sign-in does not stop the run" "status=0" "$(head -n1 <<< "$got")"
check "its reason is written down for each state to refuse with" "Error: stub refusal" \
  "$(cat "$RUNNER_TEMP/struct8-gcp/backend.error" 2>/dev/null)"
check "and the backend file is removed, so no state inits with it" "no" "$([ -f "$backend_file" ] && echo yes || echo no)"
mv "$backend_file.kept" "$backend_file"
rm -f "$RUNNER_TEMP/struct8-gcp/backend.error"

got="$(dispatch azure 0)"
check "a workspace provider the engine does not know signs in to nothing" "status=0" "$(head -n1 <<< "$got")"
check "and calls neither" "no" "$(contains "auth_" "$got")"

# ------------------------------------------------------------ destroy cleanup
STATE_URL="https://storage.googleapis.com/storage/v1/b/tfstate-b/o/states%2Fapp%2Fdefault.tfstate"
respond_with "    \"DELETE $STATE_URL\") CODE=204 ;;"
gcs_delete_object "$backend_file" tfstate-b states/app/default.tfstate
check "the state object is deleted after a destroy" "0" "$?"
check "with the backend's token" "yes" "$(contains "DELETE $STATE_URL H@[Authorization: Bearer sa-token]" "$(cat "$STUB_DIR/calls")")"
respond_with "    \"DELETE $STATE_URL\") CODE=404 ;;"
gcs_delete_object "$backend_file" tfstate-b states/app/default.tfstate
check "an object already gone counts as deleted" "0" "$?"
respond_with "    \"DELETE $STATE_URL\") CODE=403 ;;"
gcs_delete_object "$backend_file" tfstate-b states/app/default.tfstate 2> /dev/null
check "a refused delete is reported" "1" "$?"

# ------------------------------------------------------------ release-locks.sh
LOCK_URL="https://storage.googleapis.com/storage/v1/b/tfstate-b/o/states%2Fapp%2Fdefault.tflock"
ws="$work/workspace"
mkdir -p "$ws/st1/.terraform"
printf '{"pipeline_stages":[{"states":[{"path":"st1"}]}]}\n' > "$ws/manifest.json"
printf '{"backend":{"type":"gcs","config":{"bucket":"tfstate-b","prefix":"states/app","credentials":"%s"}}}\n' "$backend_file" \
  > "$ws/st1/.terraform/terraform.tfstate"

release() { (cd "$ws" && MANIFEST_PATH=manifest.json RUN_TAG=gh-7-1 bash "$work/engine/scripts/release-locks.sh" 2>&1; echo "status=$?"); }

lock_arms() {  # lock_arms <Who>
  printf '%s\n' \
    "    \"GET $LOCK_URL\") CODE=200; BODY='{\"generation\":\"1700\"}' ;;" \
    "    \"GET $LOCK_URL?alt=media&generation=1700\") CODE=200; BODY='{\"ID\":\"\",\"Who\":\"$1\"}' ;;" \
    "    \"DELETE $LOCK_URL?ifGenerationMatch=1700\") CODE=204 ;;"
}

respond_with "$(lock_arms runner@gh-7-1)"
got="$(release)"
check "release-locks ends cleanly on a gcs state" "status=0" "$(tail -n1 <<< "$got")"
check "a lock this run took is released" "yes" "$(contains "belongs to this run (gh-7-1). Releasing" "$got")"
check "only the generation that was read is deleted" "yes" "$(contains "DELETE $LOCK_URL?ifGenerationMatch=1700" "$(cat "$STUB_DIR/calls")")"

respond_with "$(lock_arms runner@gh-7-10)"
got="$(release)"
check "a lock of run gh-7-10 is not this run's (gh-7-1)" "yes" "$(contains "belongs to 'runner@gh-7-10' -- not mine" "$got")"
check "and is not deleted" "no" "$(contains "DELETE" "$(cat "$STUB_DIR/calls")")"

respond_with "    \"GET $LOCK_URL\") CODE=404 ;;"
got="$(release)"
check "no lock: nothing is read past the metadata" "no" "$(contains "alt=media" "$(cat "$STUB_DIR/calls")")"
check "and nothing is deleted" "no" "$(contains "DELETE" "$(cat "$STUB_DIR/calls")")"

respond_with '    "POST https://sts.googleapis.com/v1/token") CODE=400; BODY='"'"'{"error":"invalid_grant"}'"'"' ;;'
got="$(release)"
check "a failed sign-in is reported and does not fail the step" "yes|status=0" \
  "$(contains "Could not sign in to Cloud Storage" "$got")|$(tail -n1 <<< "$got")"

printf '{"backend":{"type":"s3","config":{"bucket":"b","key":"k","dynamodb_table":"t","region":"us-east-1"}}}\n' \
  > "$ws/st1/.terraform/terraform.tfstate"
respond_with ''
got="$(release)"
check "an S3 state still goes to DynamoDB" "yes" "$(contains "aws dynamodb get-item --table-name t" "$(cat "$STUB_DIR/calls")")"

# ------------------------------------------------------------ where pipeline.sh uses them
body="$work/run.sh"
awk '/^run_terraform_process\(\) \{/{f=1} f{print} f && /^}$/{exit}' "$PIPELINE" | tr -d '\r' > "$body"
code_lines() { grep -v '^[[:space:]]*#' "$1"; }

check "every init takes the backend's arguments from backend_init_args" "3" \
  "$(code_lines "$body" | grep -c '"${BACKEND_INIT_ARGS\[@\]}"')"
check "no init names the AWS profile itself" "0" "$(code_lines "$body" | grep -c 'profile=backend')"

guard_line=$(grep -n 'remote_backend_names)' "$body" | head -n1 | cut -d: -f1)
args_line=$(grep -n 'if ! backend_init_args > ./.struct8-live.log; then' "$body" | head -n1 | cut -d: -f1)
init_line=$(grep -n 'terraform init' "$body" | grep -v '^[0-9]*:[[:space:]]*#' | head -n1 | cut -d: -f1)
check "the arguments are chosen after the backend-block check and before the first init" "yes" \
  "$([ -n "$guard_line" ] && [ -n "$args_line" ] && [ -n "$init_line" ] && [ "$guard_line" -lt "$args_line" ] && [ "$args_line" -lt "$init_line" ] && echo yes || echo no)"
check "a refused backend is published" "yes" \
  "$(sed -n "${args_line},+4p" "$body" | grep -q 'publish_state_refusal' && echo yes || echo no)"
check "a refused target sign-in is published" "yes" \
  "$(grep -A 20 '"auth_${provider}" "$auth_json" "target" || AUTH_STATUS=$?' "$body" | grep -q 'publish_state_refusal' && echo yes || echo no)"
check "a destroy of a gcs state deletes its object" "yes" "$(grep -q 'gcs_delete_object' "$body" && echo yes || echo no)"

top="$(tr -d '\r' < "$PIPELINE")"
check "pipeline.sh loads google.sh with the other sign-ins" "yes" \
  "$(grep -q '^source "$AUTH_SCRIPTS/google.sh"$' <<< "$top" && echo yes || echo no)"
check "the backend's AWS sign-in happens only in authenticate_backend" "1" \
  "$(grep -c 'auth_aws "{\\"role_arn\\": \\"$BACKEND_ROLE\\"' <<< "$top")"
check "the run signs in to the backend through authenticate_backend" "1" \
  "$(grep -c '^    authenticate_backend "' <<< "$top")"

echo ""
if [ $failures -eq 0 ]; then
  echo "ALL CASES PASSED"
  exit 0
fi
echo "$failures CASE(S) FAILED"
exit 1
