#!/usr/bin/env bash
#
# Proves the check that stops a state from running with no backend block.
#
# WHY THIS EXISTS. Over code with no `backend` block, `terraform init` only
# warns ("Missing backend configuration") and Terraform runs on a local state
# that the runner discards. On 2026-10-12 that let an apply create resources no
# state kept, and two destroys report success and delete nothing.
#
# HOW. `remote_backend_names` is lifted out of pipeline.sh and run over folders
# written here, so the function under test is the real one. The second half
# reads run_terraform_process and checks that the refusal comes before the first
# `terraform init` and leaves alone the actions `runs_without_backend` names:
# scan, traffic, and the import draft over a folder with no backend block, which
# the check refused from 2026-10-12 to 2026-10-29. Nothing here needs AWS,
# Terraform or jq.
#
# Usage:
#   bash scripts/remote-backend-guard.test.sh

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

# ------------------------------------------------------------ the function
awk '/^remote_backend_names\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$PIPELINE" | tr -d '\r' > "$work/fn.sh"
check "remote_backend_names is defined in pipeline.sh" "1" "$(grep -c '^remote_backend_names() {' "$work/fn.sh")"
# shellcheck source=/dev/null
source "$work/fn.sh"

# Runs the function inside a folder holding the given files, as the engine does
# from inside the state's folder, under the engine's own shell options.
names_in() {
  local dir="$work/case$RANDOM$RANDOM"
  mkdir -p "$dir"
  while [ $# -gt 0 ]; do
    printf '%b' "$2" > "$dir/$1"
    shift 2
  done
  (cd "$dir" && set -eo pipefail && remote_backend_names | paste -sd, -)
}

check "the block the AWS, Cloudflare and Azure generators write" "s3" \
  "$(names_in main.tf 'terraform {\n  required_providers {}\n\n  backend "s3" {\n    bucket = "b"\n  }\n}\n')"
check "the Google generator's gcs block" "gcs" \
  "$(names_in main.tf 'terraform {\n  backend "gcs" {\n  }\n}\n')"
check "CRLF line endings" "s3" \
  "$(names_in main.tf 'terraform {\r\n  backend "s3" {\r\n  }\r\n}\r\n')"
check "a tab before the block" "s3" \
  "$(names_in main.tf 'terraform {\n\tbackend "s3" {\n\t}\n}\n')"
check "the Import tab's header, in import.tf beside no main.tf" "s3" \
  "$(names_in import.tf 'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n\nimport {\n  to = a.b\n  id = "x"\n}\n')"
check "code with no backend block" "" \
  "$(names_in main.tf 'terraform {\n  required_providers {}\n}\nresource "aws_sns_topic" "t" {}\n')"
check "a local backend does not count" "" \
  "$(names_in main.tf 'terraform {\n  backend "local" {\n  }\n}\n')"
check "a commented-out block does not count" "" \
  "$(names_in main.tf '# backend "s3" {\n// backend "s3" {\n')"
check "a folder with no .tf at all" "" \
  "$(names_in README.md 'backend "s3" {\n')"
check "a block in a .tf that is not main.tf" "s3" \
  "$(names_in main.tf 'resource "aws_sns_topic" "t" {}\n' backend.tf 'terraform {\n  backend "s3" {\n  }\n}\n')"

# ------------------------------------------------------------ who runs without one
awk '/^runs_without_backend\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$PIPELINE" | tr -d '\r' >> "$work/fn.sh"
check "runs_without_backend is defined in pipeline.sh" "1" "$(grep -c '^runs_without_backend() {' "$work/fn.sh")"
# shellcheck source=/dev/null
source "$work/fn.sh"

# Answers yes or no for an action run from a folder holding the given files.
without_backend() {
  local action="$1" dir="$work/case$RANDOM$RANDOM"
  shift
  mkdir -p "$dir"
  while [ $# -gt 0 ]; do
    printf '%b' "$2" > "$dir/$1"
    shift 2
  done
  (cd "$dir" && set -eo pipefail && if runs_without_backend "$action"; then echo yes; else echo no; fi)
}

# The account scan's draft folder, `_import/<key>/`, as the app writes it.
draft_tf='terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n\nprovider "aws" {\n  region = "us-west-2"\n}\n\nimport {\n  to = aws_s3_bucket.b\n  id = "b"\n}\n'
state_tf='terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n'
check "scan runs without a backend" "yes" "$(without_backend scan manifest.json '{}')"
check "traffic runs without a backend" "yes" "$(without_backend traffic main.tf "$state_tf")"
check "the account scan's read pass, over imports.tf with no backend block" "yes" \
  "$(without_backend read imports.tf "$draft_tf")"
check "the Import tab's pass, over a folder with no backend block" "yes" \
  "$(without_backend import imports.tf "$draft_tf")"
check "a read pass whose folder declares a backend keeps it" "no" \
  "$(without_backend read import.tf "$state_tf" imports.tf "$draft_tf")"
for action in plan drift apply destroy state_rm; do
  check "$action needs a backend" "no" "$(without_backend "$action" main.tf 'resource "aws_sns_topic" "t" {}\n')"
done

# ------------------------------------------------------------ where it runs
body="$work/run.sh"
awk '/^run_terraform_process\(\) \{/{f=1} f{print} f && /^}$/{exit}' "$PIPELINE" | tr -d '\r' > "$body"

guard_line=$(grep -n 'remote_backend_names)' "$body" | head -n1 | cut -d: -f1)
init_line=$(grep -n 'terraform init' "$body" | grep -v '^[0-9]*:[[:space:]]*#' | head -n1 | cut -d: -f1)
check "run_terraform_process calls the check" "yes" "$([ -n "$guard_line" ] && echo yes || echo no)"
check "the check comes before the first terraform init" "yes" \
  "$([ -n "$guard_line" ] && [ -n "$init_line" ] && [ "$guard_line" -lt "$init_line" ] && echo yes || echo no)"

guard_if=$(sed -n "${guard_line}p" "$body")
check "the check leaves out the actions that run without a backend" "yes" \
  "$(grep -q '! runs_without_backend "\$action"' <<< "$guard_if" && echo yes || echo no)"
args_if=$(grep -n -B1 'backend_init_args >' "$body" | head -n1)
check "init gets no backend arguments for those actions either" "yes" \
  "$(grep -q '! runs_without_backend "\$action"' <<< "$args_if" && echo yes || echo no)"

block=$(sed -n "${guard_line},/^        fi\$/p" "$body")
check "the refusal fails the state" "yes" "$(grep -q '^[[:space:]]*exit 1$' <<< "$block" && echo yes || echo no)"
for publisher in publish_plan_failure publish_apply_failure publish_destroy_failure publish_state_rm_failure; do
  check "the refusal is published through $publisher" "yes" "$(grep -q "$publisher" <<< "$block" && echo yes || echo no)"
done
check "the message starts at an Error: line, where the failure file begins reading" "yes" \
  "$(grep -q 'echo "Error: ' <<< "$block" && echo yes || echo no)"

echo ""
if [ $failures -eq 0 ]; then
  echo "ALL CASES PASSED"
  exit 0
fi
echo "$failures CASE(S) FAILED"
exit 1
