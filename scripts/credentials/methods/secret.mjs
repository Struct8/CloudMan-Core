// scripts/credentials/methods/secret.mjs
//
// Reads GitHub secrets by name: the API tokens of Cloudflare and Stripe, the
// private key of a cloud signed in with a key. The workflow passes the secrets
// the app named, and pipeline.sh hands them to sign-in.mjs on stdin.
//
// inputs:
//   secrets  { <output>: <secret name> }, e.g. { "token": "AUTH_CLOUDFLARE_0A1B2C3D" }
//   checks   optional, { <output>: { "pattern": <regex>, "expected": <what it should hold> } }
//
// outputs: one per name in `secrets`, all of them secret.

import { CredentialError } from '../entries.mjs';

export const required = ['secrets'];

/** The value of secret <name>; GitHub lists secret names in capitals. */
function lookup(secrets, name) {
	if (typeof secrets[name] === 'string') return secrets[name];
	const wanted = name.toUpperCase();
	const key = Object.keys(secrets).find((candidate) => candidate.toUpperCase() === wanted);
	return key === undefined ? undefined : secrets[key];
}

export async function signIn(entry, ctx) {
	const names = entry.inputs.secrets;
	if (!names || typeof names !== 'object' || Array.isArray(names) || !Object.keys(names).length) {
		throw new CredentialError(`Error: the ${entry.provider} sign-in names no secret.`);
	}
	const checks = entry.inputs.checks ?? {};
	const outputs = {};
	for (const [output, name] of Object.entries(names)) {
		const value = typeof name === 'string' ? lookup(ctx.secrets, name) : undefined;
		if (typeof value !== 'string' || value === '') {
			throw new CredentialError(
				`Error: secret '${name}' was not found in the repository settings.\n\nCheck that a secret with this exact name exists on GitHub.`
			);
		}
		const check = checks[output];
		if (check?.pattern && !new RegExp(check.pattern).test(value)) {
			throw new CredentialError(`Error: secret '${name}' does not hold ${check.expected || 'the expected value'}.`);
		}
		outputs[output] = value;
	}
	return { outputs, secret: Object.keys(outputs) };
}
