// scripts/credentials/methods/oidc-gcp.mjs
//
// Signs in to Google Cloud through Workload Identity Federation, then
// impersonates a service account: the sign-in auth_google does in
// scripts/auth/google.sh, with the same credential file and the same messages.
//
// inputs:
//   workload_identity_provider  projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
//   service_account             <name>@<project>.iam.gserviceaccount.com
//
// outputs: credential_json, the external_account credential file.
//
// WHY THE FILE POINTS AT A URL. A GitHub OIDC token expires 5 minutes after it
// is issued, and the access token Google trades it for lasts one hour. With
// `credential_source.url` the Google libraries inside Terraform request a fresh
// GitHub token each time they need a new access token, so an apply longer than
// an hour keeps its credential. It is the format google-github-actions/auth
// writes. The file carries the job's token-request bearer, so a delivery puts it
// under {state_dir}, never in the workspace that publish-gitops.sh commits.
//
// The sign-in is proved before the method returns, so a refusal is reported
// here, with Google's reason, instead of in the middle of a plan.

import { CredentialError } from '../entries.mjs';
import { requireTokenRequest, tokenRequestUrl } from '../github-oidc.mjs';

export const required = ['workload_identity_provider', 'service_account'];

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const PROVIDER = /^projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/;
const SERVICE_ACCOUNT = /^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$/;

/** The external_account credential file, as google.sh writes it. */
export function credentialFile(provider, serviceAccount, request) {
	return `${JSON.stringify(
		{
			type: 'external_account',
			audience: `//iam.googleapis.com/${provider}`,
			subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
			token_url: 'https://sts.googleapis.com/v1/token',
			service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
			credential_source: {
				url: tokenRequestUrl(request.url, `https://iam.googleapis.com/${provider}`),
				headers: { Authorization: `Bearer ${request.token}` },
				format: { type: 'json', subject_token_field_name: 'value' }
			}
		},
		null,
		2
	)}\n`;
}

async function call(ctx, url, init) {
	try {
		const response = await ctx.fetch(url, init);
		const body = await response.json().catch(() => ({}));
		return { status: response.status, ok: response.ok, body };
	} catch (error) {
		return { status: '000', ok: false, body: { error_description: error.message } };
	}
}

/** Google's reason in an error body: STS answers `error_description`, the other APIs `error.message`. */
function reason(body) {
	return body?.error_description || body?.error?.message || (typeof body?.error === 'string' ? body.error : '') || 'no reason given';
}

export async function signIn(entry, ctx) {
	const subject = entry.own ? 'this state' : `the Google Cloud project ${entry.account ?? ''}`.trim();
	let provider = String(entry.inputs.workload_identity_provider ?? '');
	const serviceAccount = String(entry.inputs.service_account ?? '');
	provider = provider.replace(/^\/\/iam\.googleapis\.com\//, '').replace(/^https:\/\/iam\.googleapis\.com\//, '');

	if (!provider || !serviceAccount) {
		throw new CredentialError(
			`Error: no Google Cloud sign-in for ${subject}\n\nThe run received no workload identity provider or no service account for ${subject}.`
		);
	}
	if (!PROVIDER.test(provider)) {
		throw new CredentialError(
			`Error: the workload identity provider for ${subject} is not a provider name\n\nExpected projects/<project number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>, with the project's number, not its ID.\nReceived: ${provider}`
		);
	}
	if (!SERVICE_ACCOUNT.test(serviceAccount)) {
		throw new CredentialError(
			`Error: the service account for ${subject} is not a service account email\n\nReceived: ${serviceAccount}`
		);
	}
	const request = requireTokenRequest(ctx.env);
	const audience = `//iam.googleapis.com/${provider}`;

	const github = await call(ctx, tokenRequestUrl(request.url, `https://iam.googleapis.com/${provider}`), {
		headers: { Authorization: `Bearer ${request.token}` }
	});
	const jwt = github.ok && typeof github.body?.value === 'string' ? github.body.value : '';
	if (!jwt) {
		throw new CredentialError(
			`Error: could not sign in to Google Cloud as ${serviceAccount}\n\nGitHub did not issue an OIDC token to this job (HTTP ${github.status}).`
		);
	}

	const sts = await call(ctx, 'https://sts.googleapis.com/v1/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
			audience,
			scope: SCOPE,
			requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
			subject_token: jwt
		}).toString()
	});
	const federated = sts.ok && typeof sts.body?.access_token === 'string' ? sts.body.access_token : '';
	if (!federated) {
		throw new CredentialError(
			`Error: could not sign in to Google Cloud as ${serviceAccount}\n\nThe workload identity provider ${provider} refused this run's GitHub token: ${reason(sts.body)} (HTTP ${sts.status}).\nIts attribute condition has to accept this repository, this branch and the Struct8 engine workflow.`
		);
	}

	const impersonation = await call(
		ctx,
		`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${federated}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ scope: [SCOPE] })
		}
	);
	if (!(impersonation.ok && typeof impersonation.body?.accessToken === 'string' && impersonation.body.accessToken)) {
		throw new CredentialError(
			`Error: could not sign in to Google Cloud as ${serviceAccount}\n\nThe service account refused to issue a token to this run: ${reason(impersonation.body)} (HTTP ${impersonation.status}).\nIt has to grant the Workload Identity User role to this repository's principal. A role granted in the last few minutes may not be in effect yet.`
		);
	}

	ctx.log(`   Signed in as ${serviceAccount}.`);
	return { outputs: { credential_json: credentialFile(provider, serviceAccount, request) }, secret: [] };
}
