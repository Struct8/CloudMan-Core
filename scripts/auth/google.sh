#!/bin/bash
# ==============================================================================
# GOOGLE CLOUD SIGN-IN: the state's own project ("target") and the bucket that
# holds the states ("backend"), both through Workload Identity Federation with
# this job's GitHub OIDC token, then impersonating a service account.
#
# WHY THE CREDENTIAL FILE POINTS AT A URL, NOT AT A TOKEN
#
# A GitHub OIDC token expires 5 minutes after it is issued; the access token
# Google trades it for lasts one hour. The previous version of this file wrote
# the GitHub token itself to disk (`credential_source.file`). Once the first
# access token expired, the token in the file had expired too, so an apply
# longer than an hour lost its credential in the middle. With
# `credential_source.url` the Google libraries inside Terraform request a fresh
# GitHub token each time they need a new access token. It is the same format
# google-github-actions/auth writes.
#
# WHERE THE FILE LIVES
#
# Under RUNNER_TEMP, never in the workspace: publish-gitops.sh commits the
# workspace, and the file carries the job's token-request bearer. RUNNER_TEMP is
# kept for the whole job, which release-locks.sh needs: it runs as a later step
# and signs in to the state bucket with the backend file.
#
# The auth JSON, from the manifest:
#   { "workload_identity_provider": "projects/<project number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>",
#     "service_account": "<name>@<project>.iam.gserviceaccount.com" }
#
# On failure auth_google returns 1 and leaves the reason, starting at an
# `Error:` line, in AUTH_FAILURE_MESSAGE. The caller decides where it goes.
# ==============================================================================

GOOGLE_CLOUD_PLATFORM_SCOPE="https://www.googleapis.com/auth/cloud-platform"

# Path of the credential file named <name>: `backend`, or `target-<hash>`.
google_credential_file() {
    printf '%s/struct8-gcp/%s.json\n' "${RUNNER_TEMP:-/tmp}" "$1"
}

# Percent-encodes $1 for a query value or a path segment. Byte by byte.
google_urlencode() {
    local LC_ALL=C
    local s="$1" out="" c i
    for (( i = 0; i < ${#s}; i++ )); do
        c="${s:i:1}"
        case "$c" in
            [A-Za-z0-9._~-]) out+="$c" ;;
            *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
        esac
    done
    printf '%s' "$out"
}

# One HTTP call. Writes the body to <out> and prints the status code, `000`
# when there was no answer. Every call goes through here, which is what lets
# google-backend.test.sh stand in for curl.
_google_http() {
    local method="$1" url="$2" out="$3"
    shift 3
    curl -sS --max-time 60 -X "$method" -o "$out" -w '%{http_code}' "$@" "$url" 2>/dev/null || true
}

# The same, signed with an access token. The token goes through a header file,
# not the command line, so it does not show in the runner's process list.
_google_api() {
    local method="$1" url="$2" out="$3" token="$4"
    shift 4
    printf 'Authorization: Bearer %s\n' "$token" > "${out}.h"
    _google_http "$method" "$url" "$out" -H "@${out}.h" "$@"
    rm -f "${out}.h"
}

# Google's reason in an error body: STS answers `error_description`, the other
# APIs `error.message`.
_google_reason() {
    local reason
    reason=$(jq -r '.error_description // .error.message? // .error // empty' "$1" 2>/dev/null || true)
    printf '%s' "${reason:-no reason given}"
}

# Writes the external_account credential file for <provider> and
# <service_account>. Each value is written into the JSON as it is, so auth_google
# checks every one against the only shape it can have before calling this.
google_write_credential_file() {
    local file="$1" provider="$2" service_account="$3"
    local request_url="$ACTIONS_ID_TOKEN_REQUEST_URL" separator="&" tmp

    [[ "$request_url" == *\?* ]] || separator="?"
    mkdir -p "$(dirname "$file")" && chmod 700 "$(dirname "$file")" || return 1
    tmp="${file}.${BASHPID:-$$}.tmp"
    (
        umask 077
        {
            printf '{\n'
            printf '  "type": "external_account",\n'
            printf '  "audience": "//iam.googleapis.com/%s",\n' "$provider"
            printf '  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",\n'
            printf '  "token_url": "https://sts.googleapis.com/v1/token",\n'
            printf '  "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateAccessToken",\n' "$service_account"
            printf '  "credential_source": {\n'
            printf '    "url": "%s%saudience=%s",\n' "$request_url" "$separator" "$(google_urlencode "https://iam.googleapis.com/${provider}")"
            printf '    "headers": { "Authorization": "Bearer %s" },\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN"
            printf '    "format": { "type": "json", "subject_token_field_name": "value" }\n'
            printf '  }\n'
            printf '}\n'
        } > "$tmp"
    ) || { rm -f "$tmp"; return 1; }
    # Parallel states that share a service account write the same file: each
    # writes its own copy and renames it over, so no reader sees half a file.
    mv -f "$tmp" "$file"
}

# Prints an access token for the service account in <cred_file>, following the
# file the way the Google libraries do: GitHub token, STS exchange, then
# impersonation. On failure prints the reason to stderr and returns 1.
google_access_token() {
    local file="$1"
    local request_url request_header audience token_url impersonation_url
    local work code subject federated access

    if [ ! -f "$file" ]; then
        echo "There is no Google Cloud credential file at ${file}." >&2
        return 1
    fi
    request_url=$(jq -r '.credential_source.url // empty' "$file")
    request_header=$(jq -r '.credential_source.headers.Authorization // empty' "$file")
    audience=$(jq -r '.audience // empty' "$file")
    token_url=$(jq -r '.token_url // empty' "$file")
    impersonation_url=$(jq -r '.service_account_impersonation_url // empty' "$file")

    # mktemp -d makes the folder readable by this user only, and every secret
    # below stays inside it.
    work=$(mktemp -d) || return 1

    printf 'Authorization: %s\n' "$request_header" > "$work/github.h"
    code=$(_google_http GET "$request_url" "$work/github" -H "@$work/github.h")
    subject=""
    [ "$code" == "200" ] && subject=$(jq -r '.value // empty' "$work/github" 2>/dev/null || true)
    if [ -z "$subject" ]; then
        echo "GitHub did not issue an OIDC token to this job (HTTP ${code})." >&2
        rm -rf "$work"
        return 1
    fi

    printf '%s' "$subject" > "$work/subject"
    code=$(_google_http POST "$token_url" "$work/sts" \
        --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
        --data-urlencode "audience=${audience}" \
        --data-urlencode "scope=${GOOGLE_CLOUD_PLATFORM_SCOPE}" \
        --data-urlencode "requested_token_type=urn:ietf:params:oauth:token-type:access_token" \
        --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:jwt" \
        --data-urlencode "subject_token@${work}/subject")
    federated=""
    [ "$code" == "200" ] && federated=$(jq -r '.access_token // empty' "$work/sts" 2>/dev/null || true)
    if [ -z "$federated" ]; then
        echo "The workload identity provider ${audience#//iam.googleapis.com/} refused this run's GitHub token: $(_google_reason "$work/sts") (HTTP ${code})." >&2
        echo "Its attribute condition has to accept this repository, this branch and the Struct8 engine workflow." >&2
        rm -rf "$work"
        return 1
    fi

    printf '{"scope":["%s"]}' "$GOOGLE_CLOUD_PLATFORM_SCOPE" > "$work/request.json"
    code=$(_google_api POST "$impersonation_url" "$work/sa" "$federated" \
        -H "Content-Type: application/json" --data-binary "@$work/request.json")
    access=""
    [ "$code" == "200" ] && access=$(jq -r '.accessToken // empty' "$work/sa" 2>/dev/null || true)
    if [ -z "$access" ]; then
        echo "The service account refused to issue a token to this run: $(_google_reason "$work/sa") (HTTP ${code})." >&2
        echo "It has to grant the Workload Identity User role to this repository's principal. A role granted in the last few minutes may not be in effect yet." >&2
        rm -rf "$work"
        return 1
    fi

    rm -rf "$work"
    printf '%s\n' "$access"
}

# auth_google <auth_json> <target|backend>
#
# Writes the credential file and proves it by obtaining a token, so a refusal
# is reported here, with Google's reason, instead of in the middle of a plan.
# `target` exports GOOGLE_APPLICATION_CREDENTIALS for the google provider.
# `backend` exports nothing: init hands the file to the gcs backend as
# `credentials` (see backend_init_args in pipeline.sh), because once the target
# is signed in the backend would otherwise use the target's credentials.
auth_google() {
    local auth_json="$1" type="${2:-target}"
    local provider service_account subject file err

    AUTH_FAILURE_MESSAGE=""
    echo "🇬 Authenticating Google Cloud (${type})..."

    subject="this state"
    [ "$type" == "backend" ] && subject="the bucket that holds the states"

    provider=$(jq -r '.workload_identity_provider // empty' <<< "$auth_json")
    service_account=$(jq -r '.service_account // empty' <<< "$auth_json")
    provider="${provider#//iam.googleapis.com/}"
    provider="${provider#https://iam.googleapis.com/}"

    if [ -z "$provider" ] || [ -z "$service_account" ]; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: no Google Cloud sign-in for %s\n\n%s' "$subject" \
            "The run received no workload identity provider or no service account for ${subject}.")
        return 1
    fi
    if ! [[ "$provider" =~ ^projects/[0-9]+/locations/global/workloadIdentityPools/[a-z0-9-]+/providers/[a-z0-9-]+$ ]]; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: the workload identity provider for %s is not a provider name\n\n%s\n%s' "$subject" \
            "Expected projects/<project number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>, with the project's number, not its ID." \
            "Received: ${provider}")
        return 1
    fi
    if ! [[ "$service_account" =~ ^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$ ]]; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: the service account for %s is not a service account email\n\nReceived: %s' "$subject" "$service_account")
        return 1
    fi
    if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: this job cannot request a GitHub OIDC token\n\n%s' \
            "The workflow job needs the permission id-token: write.")
        return 1
    fi
    case "$ACTIONS_ID_TOKEN_REQUEST_URL" in
        *[[:space:][:cntrl:]]*|*'"'*|*'\'*|'') err="url" ;;
        https://*) err="" ;;
        *) err="url" ;;
    esac
    if [ -n "$err" ] || ! [[ "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" =~ ^[A-Za-z0-9._-]+$ ]]; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: the GitHub OIDC token request has an unexpected format\n\n%s' \
            "ACTIONS_ID_TOKEN_REQUEST_URL or ACTIONS_ID_TOKEN_REQUEST_TOKEN does not have the shape GitHub gives them.")
        return 1
    fi

    if [ "$type" == "backend" ]; then
        file=$(google_credential_file backend)
    else
        # One file per provider and service account: parallel states of
        # different projects would otherwise overwrite each other's file.
        file=$(google_credential_file "target-$(printf '%s %s' "$provider" "$service_account" | sha256sum | cut -c1-16)")
    fi
    if ! google_write_credential_file "$file" "$provider" "$service_account"; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: could not write the Google Cloud credential file for %s\n\nPath: %s' "$subject" "$file")
        return 1
    fi

    err=$(mktemp)
    if ! google_access_token "$file" > /dev/null 2> "$err"; then
        AUTH_FAILURE_MESSAGE=$(printf 'Error: could not sign in to Google Cloud as %s\n\n%s' "$service_account" "$(cat "$err")")
        rm -f "$err"
        return 1
    fi
    rm -f "$err"

    if [ "$type" == "target" ]; then
        # These come before the Application Default Credentials in the google
        # provider's order; one left on a self-hosted runner would win.
        unset GOOGLE_CREDENTIALS GOOGLE_CLOUD_KEYFILE_JSON GCLOUD_KEYFILE_JSON GOOGLE_OAUTH_ACCESS_TOKEN
        export GOOGLE_APPLICATION_CREDENTIALS="$file"
    fi
    echo "   Signed in as ${service_account}."
}

# ==============================================================================
# THE gcs BACKEND'S OBJECTS
#
# Terraform's gcs backend keeps workspace `default` at `<prefix>/default.tfstate`
# and its lock at `<prefix>/default.tflock`. It trims the leading slashes from
# the prefix and joins with path.Join, which also collapses repeated slashes.
# The lock's content is the lock info, with `Who`; its ID is the object's
# generation, and Unlock deletes only that generation.
# ==============================================================================

# gcs_object_name <prefix> <tfstate|tflock>
gcs_object_name() {
    local prefix="$1" suffix="$2"
    while [[ "$prefix" == *//* ]]; do prefix="${prefix//\/\//\/}"; done
    prefix="${prefix#/}"
    prefix="${prefix%/}"
    printf '%s\n' "${prefix:+${prefix}/}default.${suffix}"
}

# gcs_object_url <bucket> <object>: the JSON API address of the object.
gcs_object_url() {
    printf 'https://storage.googleapis.com/storage/v1/b/%s/o/%s\n' "$1" "$(google_urlencode "$2")"
}

# gcs_delete_object <cred_file> <bucket> <object>. An object already gone counts
# as deleted.
gcs_delete_object() {
    local cred_file="$1" bucket="$2" object="$3" token work code
    token=$(google_access_token "$cred_file") || return 1
    work=$(mktemp -d) || return 1
    code=$(_google_api DELETE "$(gcs_object_url "$bucket" "$object")" "$work/delete" "$token")
    rm -rf "$work"
    case "$code" in
        200|204|404) return 0 ;;
        *) echo "Cloud Storage refused to delete gs://${bucket}/${object} (HTTP ${code})." >&2; return 1 ;;
    esac
}

# gcs_release_run_lock <cred_file> <bucket> <object> <run_tag>
#
# Releases the lock when its `Who` ends in `@<run_tag>`, the same proof
# release-locks.sh asks of a DynamoDB lock. Reads the lock at one generation and
# deletes only that generation, so a lock another run takes in between is never
# the one deleted.
gcs_release_run_lock() {
    local cred_file="$1" bucket="$2" object="$3" run_tag="$4"
    local token work code generation who url

    [ -n "$run_tag" ] || return 0
    if ! token=$(google_access_token "$cred_file" 2>/dev/null); then
        echo "⚠️  Could not sign in to Cloud Storage to check the lock on gs://${bucket}/${object}."
        return 1
    fi
    work=$(mktemp -d) || return 1
    url=$(gcs_object_url "$bucket" "$object")

    code=$(_google_api GET "$url" "$work/meta" "$token")
    if [ "$code" == "404" ]; then
        rm -rf "$work"
        return 0
    fi
    generation=$(jq -r '.generation // empty' "$work/meta" 2>/dev/null || true)
    if [ "$code" != "200" ] || ! [[ "$generation" =~ ^[0-9]+$ ]]; then
        echo "⚠️  Could not read the lock on gs://${bucket}/${object} (HTTP ${code})."
        rm -rf "$work"
        return 1
    fi

    code=$(_google_api GET "${url}?alt=media&generation=${generation}" "$work/lock" "$token")
    who=""
    [ "$code" == "200" ] && who=$(jq -r '.Who // empty' "$work/lock" 2>/dev/null || true)

    if [[ "$who" == *"@${run_tag}" ]]; then
        echo "🔓 Lock on gs://${bucket}/${object} belongs to this run (${run_tag}). Releasing..."
        code=$(_google_api DELETE "${url}?ifGenerationMatch=${generation}" "$work/delete" "$token")
        case "$code" in
            200|204) ;;
            404|412) echo "ℹ️  The lock on gs://${bucket}/${object} was released in the meantime." ;;
            *) echo "⚠️  Cloud Storage refused to delete the lock (HTTP ${code})."; rm -rf "$work"; return 1 ;;
        esac
    elif [ -n "$who" ]; then
        echo "ℹ️  Lock on gs://${bucket}/${object} belongs to '${who}' -- not mine, leaving it alone."
    fi
    rm -rf "$work"
}
