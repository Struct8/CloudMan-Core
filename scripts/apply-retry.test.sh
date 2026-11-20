#!/usr/bin/env bash
#
# Proves what the engine does when `terraform apply` fails: it runs the apply
# once more when every error is transient (`apply_with_transient_retry`, which
# asks scripts/apply-retry.mjs), says so in the log and on the run's summary
# page, and records it in the published apply_result.json
# (`_publish_state_manifest`).
#
# WHY THIS EXISTS. On 2026-11-19 a state failed on Cloudflare's "404 Not Found"
# to the read that follows the creation of a Workers custom domain, and the
# same code applied cleanly on the next run.
#
# HOW. The functions are lifted out of pipeline.sh and run under the engine's
# shell options, each scenario in a folder of its own. `terraform` is a stub
# that answers each apply from a list ("ok", "404", "403") and logs every
# call; node and apply-retry.mjs are the real ones. The section that builds the
# published file needs the real jq and says SKIP without it -- a skip is not a
# pass. Nothing here reaches a cloud or GitHub.
#
# Usage:
#   bash scripts/apply-retry.test.sh

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
LIFTED="_stream_cmd run_tf_with_stale_lock_recovery apply_with_transient_retry _publish_state_manifest publish_engine_artifact"
for fn in $LIFTED; do
  awk "/^${fn}\\(\\) \\{/{f=1} f{print} f && /^\\}/{exit}" "$PIPELINE" | tr -d '\r' >> "$work/fns.sh"
done
for fn in $LIFTED; do
  check "$fn is defined in pipeline.sh" "1" "$(grep -c "^${fn}() {" "$work/fns.sh")"
done

plain="$(tr -d '\r' < "$PIPELINE")"
check "the classifier is the one beside pipeline.sh" "1" \
  "$(grep -c '^APPLY_RETRY_CLASSIFIER="\$ENGINE_PATH/scripts/apply-retry.mjs"$' <<< "$plain")"
check "one retry" "1" "$(grep -c '^APPLY_RETRY_MAX=1$' <<< "$plain")"
check "30 seconds before it" "1" "$(grep -c '^APPLY_RETRY_WAIT_SECONDS=30$' <<< "$plain")"
check "the apply action goes through the retry" "1" \
  "$(grep -c '^ *apply_with_transient_retry "\$label" || APPLY_STATUS=\$?$' <<< "$plain")"
check "no bare terraform apply is left outside the retry" "2" \
  "$(grep -c 'terraform apply -auto-approve' <<< "$plain")"
check "the published result receives the note" "1" \
  "$(grep -c '_publish_state_manifest "\$path" apply apply_result.json "\$APPLY_RETRY_NOTE"$' <<< "$plain")"

# ------------------------------------------------------------ stubs
# The answers of the applies, one per line, are consumed in order.
cat > "$work/bin/terraform" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_TF_LOG"
case "$1" in
  apply)
    answer="$(head -n1 "$FAKE_ANSWERS")"
    tail -n +2 "$FAKE_ANSWERS" > "$FAKE_ANSWERS.rest" && mv "$FAKE_ANSWERS.rest" "$FAKE_ANSWERS"
    E=$'\033'
    echo "cloudflare_workers_custom_domain.app: Creating..."
    case "$answer" in
      ok)
        echo "Apply complete! Resources: 1 added, 0 changed, 0 destroyed."
        exit 0 ;;
      404)
        printf '%s\n' "${E}[31m╷${E}[0m" \
          "${E}[31m│${E}[0m ${E}[1m${E}[31mError: ${E}[0m${E}[1mfailed to make http request${E}[0m" \
          "${E}[31m│${E}[0m " \
          "${E}[31m│${E}[0m   with cloudflare_workers_custom_domain.app," \
          "${E}[31m│${E}[0m " \
          "${E}[31m│${E}[0m GET \"https://api.cloudflare.com/client/v4/accounts/x/workers/domains/y\":" \
          "${E}[31m│${E}[0m 404 Not Found {\"success\": false}" \
          "${E}[31m╵${E}[0m"
        exit 1 ;;
      403)
        printf '%s\n' "${E}[31m╷${E}[0m" \
          "${E}[31m│${E}[0m ${E}[1m${E}[31mError: ${E}[0m${E}[1mcreating IAM Role (app): operation error IAM: CreateRole, https response error StatusCode: 403, RequestID: 0, AccessDenied${E}[0m" \
          "${E}[31m│${E}[0m " \
          "${E}[31m│${E}[0m   with aws_iam_role.app," \
          "${E}[31m╵${E}[0m"
        exit 1 ;;
    esac ;;
  show)
    echo '{"values":{"root_module":{"resources":[{"address":"cloudflare_workers_custom_domain.app","type":"cloudflare_workers_custom_domain","name":"app","values":{"id":"d1"}}]}}}' ;;
esac
SH
chmod +x "$work/bin/terraform"

# Git for Windows ships no stdbuf; the runner does. Without it the stub keeps
# the command and drops the buffering flag.
if ! command -v stdbuf >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nshift\nexec "$@"\n' > "$work/bin/stdbuf"
  chmod +x "$work/bin/stdbuf"
fi

export PATH="$work/bin:$PATH"

# One scenario: the answers of the applies, in order. Prints what the function
# printed, then "status=<n>", "applies=<n>" and "note=<APPLY_RETRY_NOTE>".
scenario() {
  local name="$1" classifier="$2"; shift 2
  local dir="$work/$name"
  mkdir -p "$dir"
  printf '%s\n' "$@" > "$dir/answers"
  : > "$dir/tf.log"
  (
    cd "$dir"
    export FAKE_ANSWERS="$dir/answers" FAKE_TF_LOG="$dir/tf.log"
    set -eo pipefail
    YELLOW='' GREEN='' RED='' NC=''
    ENGINE_PATH="$HERE/.."
    APPLY_RETRY_CLASSIFIER="$classifier"
    APPLY_RETRY_MAX=1
    APPLY_RETRY_WAIT_SECONDS=0
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    st=0
    apply_with_transient_retry "[$name]" || st=$?
    echo "status=$st"
    echo "applies=$(grep -c '^apply' "$dir/tf.log")"
    echo "note=$APPLY_RETRY_NOTE"
  ) 2>&1
}

CLASSIFIER="$HERE/apply-retry.mjs"

# ------------------------------------------------------------ scenarios
out="$(scenario transient-then-ok "$CLASSIFIER" 404 ok)"
check "404 then success: the state passes" "yes" "$(contains 'status=0' "$out")"
check "404 then success: two applies" "yes" "$(contains 'applies=2' "$out")"
check "404 then success: the note names the first error" "yes" \
  "$(contains 'note=attempt 1: 404 Not Found on cloudflare_workers_custom_domain.app' "$out")"
check "404 then success: a warning on the summary page" "yes" \
  "$(contains '::warning title=Apply retried after a transient error::[transient-then-ok] 404 Not Found on cloudflare_workers_custom_domain.app' "$out")"
check "404 then success: the log says it passed on the retry" "yes" "$(contains 'The apply passed on retry 1.' "$out")"

out="$(scenario permanent "$CLASSIFIER" 403 ok)"
check "403: the state fails" "no" "$(contains 'status=0' "$out")"
check "403: one apply" "yes" "$(contains 'applies=1' "$out")"
check "403: no note" "yes" "$(contains $'note=\n' "$out"$'\n')"
check "403: the log says why it did not retry" "yes" \
  "$(contains 'Not retrying the apply: not transient: 403 Forbidden on aws_iam_role.app' "$out")"
check "403: no warning on the summary page" "no" "$(contains '::warning' "$out")"

out="$(scenario transient-twice "$CLASSIFIER" 404 404 ok)"
check "404 twice: the state fails after the one retry" "no" "$(contains 'status=0' "$out")"
check "404 twice: two applies, not three" "yes" "$(contains 'applies=2' "$out")"
check "404 twice: the live log holds the last attempt" "yes" \
  "$(contains '404 Not Found' "$(cat "$work/transient-twice/.struct8-live.log")")"

out="$(scenario transient-then-permanent "$CLASSIFIER" 404 403)"
check "404 then 403: the state fails" "no" "$(contains 'status=0' "$out")"
check "404 then 403: the live log holds the 403, which is what gets published" "yes" \
  "$(contains 'StatusCode: 403' "$(cat "$work/transient-then-permanent/.struct8-live.log")")"

out="$(scenario success "$CLASSIFIER" ok)"
check "success: one apply" "yes" "$(contains 'applies=1' "$out")"
check "success: no note, no warning" "no" "$(contains '::warning' "$out")"
check "success: status 0" "yes" "$(contains 'status=0' "$out")"

out="$(scenario no-classifier "$work/missing.mjs" 404 ok)"
check "classifier missing: no retry, the failure stands" "no" "$(contains 'status=0' "$out")"
check "classifier missing: one apply" "yes" "$(contains 'applies=1' "$out")"
check "classifier missing: the subshell survived set -e to report" "yes" "$(contains 'note=' "$out")"

# ------------------------------------------------------------ published file
if command -v jq >/dev/null 2>&1; then
  pub="$work/publish"
  mkdir -p "$pub"
  (
    cd "$pub"
    export FAKE_ANSWERS="$pub/answers" FAKE_TF_LOG="$pub/tf.log" RUNNER_TEMP="$pub/tmp"
    : > "$FAKE_ANSWERS"
    set -eo pipefail
    YELLOW='' GREEN='' RED='' NC=''
    # shellcheck source=/dev/null
    source "$work/fns.sh"
    _publish_state_manifest "./retried" apply apply_result.json "attempt 1: 404 Not Found on cloudflare_workers_custom_domain.app"
    mv "$RUNNER_TEMP/struct8-artifacts/retried.apply_result.json.gz" retried.gz
    _publish_state_manifest "./clean" apply apply_result.json ""
    mv "$RUNNER_TEMP/struct8-artifacts/clean.apply_result.json.gz" clean.gz
  ) > /dev/null 2>&1
  check "a retried apply publishes retried_after" \
    "attempt 1: 404 Not Found on cloudflare_workers_custom_domain.app" \
    "$(gzip -dc "$pub/retried.gz" 2>/dev/null | jq -r '.cloudman_result.retried_after')"
  check "a retried apply still publishes success" "succeeded" \
    "$(gzip -dc "$pub/retried.gz" 2>/dev/null | jq -r '.cloudman_result.outcome')"
  check "an apply that was not retried publishes no retried_after" "false" \
    "$(gzip -dc "$pub/clean.gz" 2>/dev/null | jq '.cloudman_result | has("retried_after")')"
  check "the resources are still published" "cloudflare_workers_custom_domain.app" \
    "$(gzip -dc "$pub/clean.gz" 2>/dev/null | jq -r '.resources[0].address')"
else
  echo "SKIP - the published file (no jq on this machine)"
  skips=$((skips + 1))
fi

echo
if [ $failures -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
if [ $skips -gt 0 ]; then
  echo "All checks passed ($skips skipped)."
else
  echo "All checks passed."
fi
