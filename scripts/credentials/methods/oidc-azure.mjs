// scripts/credentials/methods/oidc-azure.mjs
//
// Trades this job's GitHub OIDC token, issued for api://AzureADTokenExchange,
// with Microsoft Entra ID through the federated credential of an application,
// the sign-in auth_azure does in scripts/auth/azure.sh.
//
// inputs:
//   tenant_id        the directory
//   client_id        the application that holds the federated credential
//   subscription_id  optional, selected after the sign-in
//
// outputs: oidc_token, the GitHub token, which the azurerm provider reads from
// ARM_OIDC_TOKEN.

import { CredentialError } from '../entries.mjs';
import { githubOidcToken } from '../github-oidc.mjs';

export const required = ['tenant_id', 'client_id'];

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function signIn(entry, ctx) {
	const { tenant_id: tenant, client_id: client, subscription_id: subscription } = entry.inputs;
	for (const [name, value] of [
		['tenant ID', tenant],
		['client ID', client],
		...(subscription ? [['subscription ID', subscription]] : [])
	]) {
		if (!GUID.test(String(value ?? ''))) {
			throw new CredentialError(`Error: the Azure sign-in received '${value}' as the ${name}, which is not a GUID.`);
		}
	}
	const jwt = await githubOidcToken('api://AzureADTokenExchange', ctx);

	const login = ctx.run('az', [
		'login',
		'--service-principal',
		'--username',
		client,
		'--tenant',
		tenant,
		'--federated-token',
		jwt,
		'--output',
		'none'
	]);
	if (login.status !== 0) {
		throw new CredentialError(
			`Error: could not sign in to Azure as the application ${client}\n\n${String(login.stderr || '').trim() || 'Azure gave no reason.'}`
		);
	}
	if (subscription) {
		const select = ctx.run('az', ['account', 'set', '--subscription', subscription]);
		if (select.status !== 0) {
			throw new CredentialError(
				`Error: the application ${client} cannot reach the subscription ${subscription}\n\n${String(select.stderr || '').trim()}`
			);
		}
	}
	return { outputs: { oidc_token: jwt }, secret: ['oidc_token'] };
}
