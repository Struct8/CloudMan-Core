// scripts/credentials/methods/oidc-oci.mjs
//
// Signs in to Oracle Cloud Infrastructure through Workload Identity Federation:
// the job's GitHub OIDC token is traded for a resource principal session token
// (RPST) at the token endpoint of the tenancy's identity domain, and the
// provider signs in as a resource principal, version 2.2, from the token and
// the private key whose public half the token carries.
//
// inputs:
//   domain_url          https://idcs-<id>.identity.oraclecloud.com, the Default identity domain
//   client_id           the confidential application the exchange authenticates as
//   client_secret_name  the GitHub secret holding that application's client secret,
//                       AUTH_OCI_<tenancy name>
//   resource_type       the `impersonatingResource` of the domain's identity
//                       propagation trust; the exchange sends it as `res_type`
//   rpst_minutes        optional, the token's lifetime in minutes (`rpst_exp`);
//                       OCI gives 20 without it, and accepts up to 720
//
// outputs: rpst, the session token; private_key_pem, the PKCS#8 key it is bound
// to. Both secret.
//
// WHERE THE SETUP COMES FROM. The app's GitOps Workspace panel prints Cloud
// Shell commands (src/lib/services/cloud/oci/workloadIdentityCommands.ts, in
// the CloudMan repository) that create the application, the trust and an IAM
// policy that lets a token of this repository, on main, run by this engine,
// manage the tenancy. The panel saves the client secret as the repository
// secret and writes the other inputs on the OCI Tenancy component, which the
// push sends here. The exchange follows "Token Exchange Grant Type: Exchanging a
// JSON Web Token for an RPST" on docs.oracle.com, and the reference
// implementation github.com/dgutierrezcolodra/oci-terraform-github-actions-wif-example.
//
// THE KEY PAIR IS MADE HERE, per run. Its public half goes to OCI in the
// request, and the RPST is bound to it: the token alone signs nothing. A
// delivery writes both under {state_dir}, never in the workspace that
// publish-gitops.sh commits.

import { generateKeyPairSync } from 'node:crypto';
import { CredentialError } from '../entries.mjs';
import { githubOidcToken } from '../github-oidc.mjs';

export const required = ['domain_url', 'client_id', 'client_secret_name', 'resource_type'];

/** The audience OCI's identity propagation trust receives from GitHub. */
export const AUDIENCE = 'https://cloud.oracle.com';

const DOMAIN_URL = /^https:\/\/idcs-[0-9a-f]{16,64}\.identity\.oraclecloud\.com$/;
const CLIENT_ID = /^[A-Za-z0-9_.-]{8,128}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const RESOURCE_TYPE = /^[A-Za-z0-9_]{1,64}$/;
const MAX_MINUTES = 720;

/** The value of secret <name>; GitHub lists secret names in capitals. */
function lookup(secrets, name) {
	if (typeof secrets?.[name] === 'string') return secrets[name];
	const wanted = name.toUpperCase();
	const key = Object.keys(secrets ?? {}).find((candidate) => candidate.toUpperCase() === wanted);
	return key === undefined ? undefined : secrets[key];
}

/** OCI's reason in an error body of the token endpoint. */
function reason(body) {
	return body?.error_description || body?.detail || (typeof body?.error === 'string' ? body.error : '') || 'no reason given';
}

/** The lifetime the token carries, in whole minutes, or null when it cannot be read. */
export function tokenMinutes(token) {
	try {
		const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf-8'));
		const seconds = Number(payload.exp) - Number(payload.iat);
		return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null;
	} catch {
		return null;
	}
}

/** A fresh RSA 2048 pair: the public half as base64 DER (SPKI), the private half as PKCS#8 PEM. */
export function keyPair() {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'der' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
	});
	return { publicKey: Buffer.from(publicKey).toString('base64'), privateKeyPem: privateKey };
}

export async function signIn(entry, ctx) {
	const subject = entry.own ? 'this state' : `the OCI tenancy ${entry.account ?? ''}`.trim();
	const domainUrl = String(entry.inputs.domain_url ?? '').replace(/\/+$/, '');
	const clientId = String(entry.inputs.client_id ?? '');
	const secretName = String(entry.inputs.client_secret_name ?? '');
	const resourceType = String(entry.inputs.resource_type ?? '');
	const minutesInput = entry.inputs.rpst_minutes;

	if (!DOMAIN_URL.test(domainUrl)) {
		throw new CredentialError(
			`Error: the identity domain URL for ${subject} is not one\n\nExpected https://idcs-<id>.identity.oraclecloud.com, with no port and no path.\nReceived: ${domainUrl}`
		);
	}
	if (!CLIENT_ID.test(clientId)) {
		throw new CredentialError(`Error: the client ID for ${subject} is not one\n\nReceived: ${clientId}`);
	}
	if (!SECRET_NAME.test(secretName)) {
		throw new CredentialError(`Error: the OCI sign-in for ${subject} names no usable secret\n\nReceived: ${secretName}`);
	}
	if (!RESOURCE_TYPE.test(resourceType)) {
		throw new CredentialError(`Error: the OCI sign-in for ${subject} has an unusable resource type\n\nReceived: ${resourceType}`);
	}
	let minutes = '';
	if (minutesInput !== undefined && minutesInput !== null && minutesInput !== '') {
		const value = Number(minutesInput);
		if (!Number.isInteger(value) || value < 1 || value > MAX_MINUTES) {
			throw new CredentialError(
				`Error: the OCI session lifetime for ${subject} is not a whole number of minutes from 1 to ${MAX_MINUTES}\n\nReceived: ${minutesInput}`
			);
		}
		minutes = String(value);
	}

	const clientSecret = lookup(ctx.secrets, secretName);
	if (typeof clientSecret !== 'string' || clientSecret === '') {
		throw new CredentialError(
			`Error: secret '${secretName}' was not found in the repository settings.\n\nCheck that a secret with this exact name exists on GitHub. The GitOps Workspace panel of the OCI tenancy saves it.`
		);
	}
	if (/[\s]/.test(clientSecret)) {
		throw new CredentialError(`Error: secret '${secretName}' does not hold an OCI client secret: it has spaces or line breaks.`);
	}

	const jwt = await githubOidcToken(AUDIENCE, ctx);
	const { publicKey, privateKeyPem } = keyPair();

	const form = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
		requested_token_type: 'urn:oci:token-type:oci-rpst',
		subject_token: jwt,
		subject_token_type: 'jwt',
		public_key: publicKey,
		res_type: resourceType
	});
	if (minutes) form.set('rpst_exp', minutes);

	let status = '000';
	let body = {};
	try {
		const response = await ctx.fetch(`${domainUrl}/oauth2/v1/token`, {
			method: 'POST',
			redirect: 'error',
			headers: {
				Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json'
			},
			body: form.toString()
		});
		status = response.status;
		body = (await response.json().catch(() => ({}))) ?? {};
		if (!response.ok) body = { ...body, failed: true };
	} catch (error) {
		body = { failed: true, error_description: error.message };
	}
	const token = !body.failed && typeof body.token === 'string' ? body.token : '';
	if (!token) {
		throw new CredentialError(
			`Error: could not sign in to OCI as the application ${clientId}\n\nThe identity domain ${domainUrl} refused this run's GitHub token: ${reason(body)} (HTTP ${status}).\n` +
				`The client secret has to be the one in '${secretName}', the domain's identity propagation trust has to list this application and accept the GitHub issuer, and its resource type has to be ${resourceType}.`
		);
	}

	const lifetime = tokenMinutes(token);
	ctx.log(`   Signed in as the application ${clientId}${lifetime ? `, for ${lifetime} minutes` : ''}.`);
	return { outputs: { rpst: token, private_key_pem: privateKeyPem }, secret: ['rpst', 'private_key_pem'] };
}
