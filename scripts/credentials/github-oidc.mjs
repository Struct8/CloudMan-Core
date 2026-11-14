// scripts/credentials/github-oidc.mjs
//
// This job's GitHub OIDC token for an audience. The methods that trade it with a
// cloud call this, the way scripts/auth/utils.sh `get_github_oidc_token` does
// for the shell. The token expires five minutes after GitHub issues it.

import { CredentialError } from './entries.mjs';

/** Throws unless the job can ask GitHub for a token. */
export function requireTokenRequest(env) {
	const url = env.ACTIONS_ID_TOKEN_REQUEST_URL ?? '';
	const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? '';
	if (!url || !token) {
		throw new CredentialError(
			'Error: this job cannot request a GitHub OIDC token\n\nThe workflow job needs the permission id-token: write.'
		);
	}
	if (!/^https:\/\/[^\s"\\]+$/.test(url) || !/^[A-Za-z0-9._-]+$/.test(token)) {
		throw new CredentialError(
			'Error: the GitHub OIDC token request has an unexpected format\n\nACTIONS_ID_TOKEN_REQUEST_URL or ACTIONS_ID_TOKEN_REQUEST_TOKEN does not have the shape GitHub gives them.'
		);
	}
	return { url, token };
}

/** The URL that asks GitHub for a token with <audience>. */
export function tokenRequestUrl(url, audience) {
	return `${url}${url.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
}

export async function githubOidcToken(audience, ctx) {
	const { url, token } = requireTokenRequest(ctx.env);
	let response;
	try {
		response = await ctx.fetch(tokenRequestUrl(url, audience), {
			headers: { Authorization: `Bearer ${token}` }
		});
	} catch (error) {
		throw new CredentialError(`Error: GitHub did not issue an OIDC token to this job\n\n${error.message}`);
	}
	const body = await response.json().catch(() => null);
	if (!response.ok || typeof body?.value !== 'string' || body.value === '') {
		throw new CredentialError(`Error: GitHub did not issue an OIDC token to this job (HTTP ${response.status}).`);
	}
	return body.value;
}
