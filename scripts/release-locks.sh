#!/usr/bin/env bash
# Releases a Terraform state lock left behind when this run was cancelled or
# timed out.
#
# Lives here, and not in the workflow, because the workflow is ONE file shared by
# every channel and every customer -- anything encoded there can only change for
# everyone at once, while this script is checked out per channel. Recovery logic
# is exactly the kind of thing that gets refined, so it belongs on the side that
# can be refined for one channel at a time.
#
# Only deletes a lock it can prove belongs to THIS run, by matching the RUN_TAG
# written into the lock's owner field. Never a blind delete.
#
# Expects in the environment: MANIFEST_PATH, RUN_TAG, DEFAULT_REGION.
# Matches what `shell: bash` gives a workflow step by default
# (bash -eo pipefail), so moving this body out of the workflow did not
# quietly change how it reacts to a failing command. Same line as pipeline.sh.
set -eo pipefail

MANIFEST_PATH="${MANIFEST_PATH:-}"
[ -f "$MANIFEST_PATH" ] || exit 0

jq -c '.pipeline_stages[].states[]' "$MANIFEST_PATH" | while read -r state; do
    path=$(echo "$state" | jq -r '.path')
    cache_file="$path/.terraform/terraform.tfstate"
    [ -f "$cache_file" ] || continue   # esse path nem chegou a dar init

    bucket=$(jq -r '.backend.config.bucket // empty' "$cache_file")
    key=$(jq -r '.backend.config.key // empty' "$cache_file")
    table=$(jq -r '.backend.config.dynamodb_table // empty' "$cache_file")
    region=$(jq -r '.backend.config.region // empty' "$cache_file")
    [ -n "$bucket" ] && [ -n "$key" ] && [ -n "$table" ] || continue

    item=$(aws dynamodb get-item \
        --table-name "$table" \
        --key "{\"LockID\": {\"S\": \"${bucket}/${key}\"}}" \
        --region "${region:-$DEFAULT_REGION}" --profile backend 2>/dev/null)

    who=$(echo "$item" | jq -r '.Item.Info.S // empty' | jq -r '.Who // empty' 2>/dev/null)

    if [ "$who" == "runner@${RUN_TAG}" ]; then
        echo "🔓 Lock on ${bucket}/${key} belongs to this run (${RUN_TAG}). Releasing..."
        aws dynamodb delete-item --table-name "$table" \
            --key "{\"LockID\": {\"S\": \"${bucket}/${key}\"}}" \
            --region "${region:-$DEFAULT_REGION}" --profile backend
    elif [ -n "$who" ]; then
        echo "ℹ️  Lock on ${bucket}/${key} belongs to '${who}' -- not mine, leaving it alone."
    fi
done
