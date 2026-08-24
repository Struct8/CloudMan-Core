#!/usr/bin/env bash
#
# Proves which action reaches which branch of PASSO 3.
#
# WHY THIS EXISTS. The dispatch used to have no `else`, so an action the engine
# did not know ran init and target auth, matched nothing, and the run finished
# GREEN having done nothing -- while the app waited for a file that was never
# going to arrive. That failure is invisible in every log; the only thing that
# catches it is asserting the routing itself.
#
# HOW. It lifts the top-level `if/elif/else/fi` keywords out of pipeline.sh and
# rebuilds the chain with one marker per branch. So the CONDITIONS under test are
# the real ones, copied from the file, while the bodies are not executed -- which
# is what lets this run with no AWS, no Terraform and no jq.
#
# WHAT IT DOES NOT COVER. What each branch does once reached. That is the job of
# scan-account.test.mjs for the scan, and of a real run for the rest.
#
# Usage:
#   bash scripts/pipeline-dispatch.test.sh

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

# ---------------------------------------------------------------- the chain
#
# From the PASSO 3 marker to the `)` that closes the subshell, keeping only the
# branch keywords at exactly eight spaces of indent. Inner conditionals sit at
# ten or more, so they are left behind with the bodies.
chain_file="$(mktemp)"
trap 'rm -f "$chain_file"' EXIT

awk '/PASSO 3: EXECU/{f=1} f && /^    \)$/{exit} f' "$PIPELINE" \
  | grep -E '^        (if|elif|else|fi)' > "$chain_file"

branch_count=$(grep -cE '^        (if|elif)' "$chain_file")
has_else=$(grep -cE '^        else$' "$chain_file")

check "the chain still ends in an else, so no action falls through in silence" "1" "$has_else"

# Rebuild: every branch keyword kept verbatim, every body replaced by a marker.
runner="$(mktemp)"
trap 'rm -f "$chain_file" "$runner"' EXIT
{
  echo 'action="$1"'
  n=0
  while IFS= read -r line; do
    case "$line" in
      *fi) echo "$line" ;;
      *)
        n=$((n + 1))
        echo "$line"
        echo "  echo BRANCH_$n"
        ;;
    esac
  done < "$chain_file"
} > "$runner"

fired() { bash "$runner" "$1" 2>/dev/null; }

# --------------------------------------------------------------- the routing
check "plan reaches the plan branch"        "BRANCH_1" "$(fired plan)"
check "drift shares it, as -refresh-only"   "BRANCH_1" "$(fired drift)"
check "apply reaches the apply branch"      "BRANCH_2" "$(fired apply)"
check "import reaches the draft branch"     "BRANCH_3" "$(fired import)"
check "read reaches THE SAME branch"        "BRANCH_3" "$(fired read)"
check "scan reaches the scan branch"        "BRANCH_4" "$(fired scan)"
check "destroy reaches the destroy branch"  "BRANCH_5" "$(fired destroy)"

# The one that used to pass in silence.
check "an unknown action reaches the else"  "BRANCH_6" "$(fired quietly-wrong)"
check "an empty action reaches it too"      "BRANCH_6" "$(fired '')"

# Five conditions plus the else, which is the sixth marker but not an `elif`.
# Here so that a branch added without a case above fails this instead of being
# routed by an expectation nobody wrote.
check "and the chain has exactly the five conditions this test knows about" "5" "$branch_count"

# ------------------------------------------------- the init skip, structurally
#
# Asserted by reading rather than by running: the init sits above PASSO 3, in the
# middle of credential handling that cannot be lifted out the way the chain can.
# A structural check is weaker, and it is here because the alternative is nothing.
init_guard=$(awk '/PASSO 1: TERRAFORM INIT/{f=1} f && /PASSO 2: PREPARA/{exit} f' "$PIPELINE" \
  | grep -c 'if \[ "$action" == "scan" \]; then')
check "a scan skips terraform init, which has nothing to initialise" "1" "$init_guard"

echo
if [ "$failures" -eq 0 ]; then
  echo "ALL CASES PASSED"
  exit 0
fi
echo "$failures CASE(S) FAILED"
exit 1
