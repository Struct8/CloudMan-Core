#!/usr/bin/env bash
#
# Proves how the engine writes a blue/green split into a CloudFront
# KeyValueStore key (`_traffic_write_aws_kvs`), and that `apply_traffic_split`
# sends each manifest entry to the store its `store_type` names.
#
# WHY THIS EXISTS. A CloudFront Function reads no service but the KeyValueStore,
# so a router at the edge sees the split only if the engine writes it there. The
# store takes a write only with its current ETag; a write that loses that race
# has to read and merge again, or it would put back a document without the
# stage another operator just wrote.
#
# HOW. The functions are lifted out of pipeline.sh. `aws` is a stub that keeps
# the key's value and the store's ETag in files and logs every call. jq is the
# real one; without it the test says SKIP, and a skip is not a pass. Nothing
# here reaches AWS.
#
# Usage:
#   bash scripts/traffic-store.test.sh

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

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP - jq is not installed; every check here needs it"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/kvs"

# ------------------------------------------------------------ the functions
# Line endings stripped: a Windows checkout carries CRLF, which bash does not
# read.
LIFTED="_traffic_merge _traffic_write_aws _traffic_write_aws_kvs _traffic_write_cloudflare apply_traffic_split"
for fn in $LIFTED; do
  awk "/^${fn}\\(\\) \\{/{f=1} f{print} f && /^\\}/{exit}" "$PIPELINE" | tr -d '\r' >> "$work/fns.sh"
done
for fn in $LIFTED; do
  check "$fn is defined in pipeline.sh" "1" "$(grep -c "^${fn}() {" "$work/fns.sh")"
done
# shellcheck disable=SC1091
source "$work/fns.sh"

# ------------------------------------------------------------ the aws stub
# KVS state: kvs/value (absent = no key), kvs/etag. Knobs: kvs/conflicts (how
# many puts lose the race to another writer, which adds a `beta` stage),
# kvs/get-error (what get-key fails with).
cat > "$work/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$KVS_DIR/calls.log"
svc=$1 op=$2
shift 2
arn="" key="" value="" ifmatch="" name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kvs-arn) arn=$2; shift 2 ;;
    --key) key=$2; shift 2 ;;
    --value) value=$2; shift 2 ;;
    --if-match) ifmatch=$2; shift 2 ;;
    --name) name=$2; shift 2 ;;
    *) shift ;;
  esac
done
case "$svc $op" in
  "cloudfront-keyvaluestore describe-key-value-store")
    cat "$KVS_DIR/etag" ;;
  "cloudfront-keyvaluestore get-key")
    if [ -f "$KVS_DIR/get-error" ]; then cat "$KVS_DIR/get-error" >&2; exit 254; fi
    if [ ! -f "$KVS_DIR/value" ]; then
      echo "An error occurred (ResourceNotFoundException) when calling the GetKey operation: Key not found" >&2
      exit 254
    fi
    cat "$KVS_DIR/value" ;;
  "cloudfront-keyvaluestore put-key")
    left=$(cat "$KVS_DIR/conflicts" 2>/dev/null || echo 0)
    if [ "$left" -gt 0 ]; then
      echo $((left - 1)) > "$KVS_DIR/conflicts"
      echo '{"beta":{"blue":"7","greenPercentage":0}}' > "$KVS_DIR/value"
      echo $(( $(cat "$KVS_DIR/etag") + 1 )) > "$KVS_DIR/etag"
    fi
    if [ "$ifmatch" != "$(cat "$KVS_DIR/etag")" ]; then
      echo "An error occurred (ConflictException) when calling the PutKey operation: ETag mismatch" >&2
      exit 254
    fi
    printf '%s' "$value" > "$KVS_DIR/value"
    echo $(( $(cat "$KVS_DIR/etag") + 1 )) > "$KVS_DIR/etag" ;;
  "ssm get-parameter")
    echo "An error occurred (ParameterNotFound)" >&2; exit 254 ;;
  "ssm put-parameter")
    : ;;
  *)
    echo "stub: unexpected call $svc $op" >&2; exit 2 ;;
esac
STUB
chmod +x "$work/bin/aws"
export PATH="$work/bin:$PATH"
export KVS_DIR="$work/kvs"

ARN="arn:aws:cloudfront::123456789012:key-value-store/abc"
ADDRESS="{\"key_value_store_arn\":\"$ARN\"}"
SPLIT='{"blue":"3","green":"4","greenPercentage":20}'

reset_store() {
  rm -f "$KVS_DIR"/*
  echo 1 > "$KVS_DIR/etag"
}
calls() { local n; n=$(grep -c "$1" "$KVS_DIR/calls.log" 2>/dev/null); echo "${n:-0}"; }

# ------------------------------------------------- first write: no key yet
reset_store
out=$(_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "$ADDRESS" "[t]" 2>&1); rc=$?
check "a missing key is the first write, and it succeeds" "0" "$rc"
check "the document holds only this stage" '{"prod":{"blue":"3","green":"4","greenPercentage":20}}' "$(cat "$KVS_DIR/value")"
check "the write names the ETag it read" "1" "$(grep -c -- "put-key .*--if-match 1" "$KVS_DIR/calls.log")"

# ------------------------------------------------- other stages are kept
reset_store
echo '{"beta":{"blue":"7","greenPercentage":0}}' > "$KVS_DIR/value"
_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "$ADDRESS" "[t]" >/dev/null 2>&1
check "the beta stage survives a write to prod" "7" "$(jq -r '.beta.blue' "$KVS_DIR/value")"
check "and prod is in" "20" "$(jq -r '.prod.greenPercentage' "$KVS_DIR/value")"

# ------------------------------------------------- losing the ETag race
reset_store
echo 1 > "$KVS_DIR/conflicts"
out=$(_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "$ADDRESS" "[t]" 2>&1); rc=$?
check "a write that loses the race is tried again, and succeeds" "0" "$rc"
check "the retry read the key again" "2" "$(calls 'get-key')"
check "the stage the other writer added is kept" "7" "$(jq -r '.beta.blue' "$KVS_DIR/value")"
check "the refused attempt is reported" "1" "$(echo "$out" | grep -c 'refused write 1 of 3')"

reset_store
echo 5 > "$KVS_DIR/conflicts"
out=$(_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "$ADDRESS" "[t]" 2>&1); rc=$?
check "three refusals in a row fail the write" "1" "$rc"
check "and it stops after three puts" "3" "$(calls 'put-key')"

# ------------------------------------------------- a read that is not 'missing'
reset_store
echo '{"beta":{"blue":"7","greenPercentage":0}}' > "$KVS_DIR/value"
echo "An error occurred (AccessDeniedException) when calling the GetKey operation" > "$KVS_DIR/get-error"
out=$(_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "$ADDRESS" "[t]" 2>&1); rc=$?
check "a read refused for permission fails the write" "1" "$rc"
check "and nothing is written over the other stages" "0" "$(calls 'put-key')"

# ------------------------------------------------- refusals before any call
reset_store
out=$(_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "{}" "[t]" 2>&1); rc=$?
check "an entry without the store ARN fails" "1" "$rc"
check "and says what is missing" "1" "$(echo "$out" | grep -c 'key_value_store_arn')"
check "without calling AWS" "0" "$(calls 'cloudfront-keyvaluestore')"

reset_store
big=$(printf '{"blue":"%01000d","greenPercentage":0}' 0)
echo "{\"beta\":$big}" > "$KVS_DIR/value"
out=$(_traffic_write_aws_kvs "traffic" "prod" "$SPLIT" "$ADDRESS" "[t]" 2>&1); rc=$?
check "a document over 1 KB fails" "1" "$rc"
check "and says its size" "1" "$(echo "$out" | grep -c 'holds at most 1024')"
check "without a put" "0" "$(calls 'put-key')"

# ------------------------------------------------- routing by store_type
reset_store
entry="{\"document\":\"traffic\",\"stage\":\"prod\",\"split\":$SPLIT,\"address\":$ADDRESS,\"store_type\":\"aws_cloudfrontkeyvaluestore_key\"}"
apply_traffic_split "$entry" "aws" "[t]" >/dev/null 2>&1
check "store_type aws_cloudfrontkeyvaluestore_key goes to the KeyValueStore" "1" "$(calls 'put-key')"
check "and not to the SSM" "0" "$(calls 'ssm ')"

reset_store
entry="{\"document\":\"traffic\",\"stage\":\"prod\",\"split\":$SPLIT,\"address\":{\"region\":\"sa-east-1\"}}"
apply_traffic_split "$entry" "aws" "[t]" >/dev/null 2>&1
check "an entry without store_type still goes to the SSM parameter" "1" "$(calls 'ssm put-parameter')"
check "and not to the KeyValueStore" "0" "$(calls 'cloudfront-keyvaluestore')"

echo
if [ "$failures" -eq 0 ]; then
  echo "All checks passed."
else
  echo "$failures check(s) failed."
  exit 1
fi
