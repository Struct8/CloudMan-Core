#!/bin/bash

function auth_oci() {
    echo "⭕ Authenticating Oracle Cloud..."

    if [ -z "$OCI_PRIVATE_KEY" ]; then
         echo "❌ Error: OCI secrets are missing." >&2
         return 1
    fi

    echo "$OCI_PRIVATE_KEY" > /tmp/oci_api_key.pem
    chmod 600 /tmp/oci_api_key.pem

    export TF_VAR_tenancy_ocid="$OCI_TENANCY"
    export TF_VAR_user_ocid="$OCI_USER"
    export TF_VAR_fingerprint="$OCI_FINGERPRINT"
    export TF_VAR_private_key_path="/tmp/oci_api_key.pem"
    export TF_VAR_region="$OCI_REGION"
}
