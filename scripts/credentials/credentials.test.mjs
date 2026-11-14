// Cases for scripts/credentials: the entries of a state's `credentials`, the
// methods with GitHub, AWS and Google stood in for, and the script the shell
// sources.
//
// WHY. These entries replace the provider-by-provider sign-in of pipeline.sh
// (the `additional_auth` loop, `auth_${provider}`), and a mistake here does not
// fail loudly: a token in the wrong variable, or an AWS profile written over by
// a state running beside it, shows up as a provider error in the middle of a
// plan, or as a plan in the wrong account. The fixtures are the entries the app
// writes for each cloud (src/lib/resources/*/*_cloud_/definition.js,
// `credentialStrategy.credentials`, in the CloudMan repository).
//
// Usage: node scripts/credentials/credentials.test.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collisions, replaceIniSection, validateEntries } from './entries.mjs';
import { knownMethod, signInEntries } from './sign-in.mjs';
import { sessionName } from './methods/oidc-aws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${String(detail).split('\n').join('\n         ')}`);
		failures++;
	}
}

// ---------------------------------------------------------------------------
// Fixtures: the entries the app writes.
// ---------------------------------------------------------------------------

const ROLE_OWN = 'arn:aws:iam::111122223333:role/Struct8-Gitops-acme-infra';
const ROLE_FOREIGN = 'arn:aws:iam::444455556666:role/Struct8-Gitops-acme-infra';

const awsOwn = {
	id: 'aws-111122223333',
	provider: 'aws',
	account: '111122223333',
	own: true,
	method: 'oidc-aws',
	inputs: { role_arn: ROLE_OWN, region: 'us-east-1', session_scope: '' },
	deliver: [
		{
			kind: 'ini',
			path: '{state_dir}/aws/credentials',
			seed: '~/.aws/credentials',
			section: 'target',
			keys: {
				aws_access_key_id: { from: 'access_key_id' },
				aws_secret_access_key: { from: 'secret_access_key' },
				aws_session_token: { from: 'session_token' }
			}
		},
		{
			kind: 'ini',
			path: '{state_dir}/aws/config',
			seed: '~/.aws/config',
			section: 'profile target',
			keys: { region: { value: 'us-east-1' } }
		},
		{
			kind: 'env',
			vars: {
				AWS_SHARED_CREDENTIALS_FILE: { value: '{state_dir}/aws/credentials' },
				AWS_CONFIG_FILE: { value: '{state_dir}/aws/config' },
				AWS_PROFILE: { value: 'target' },
				AWS_REGION: { value: 'us-east-1' }
			},
			unset: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']
		}
	]
};

const awsForeign = {
	id: 'aws-444455556666',
	provider: 'aws',
	account: '444455556666',
	own: false,
	method: 'oidc-aws',
	inputs: { role_arn: ROLE_FOREIGN, region: 'us-east-1', session_scope: 'acct_444455556666' },
	deliver: [
		{
			kind: 'ini',
			path: '{state_dir}/aws/credentials',
			seed: '~/.aws/credentials',
			section: 'acct_444455556666',
			keys: {
				aws_access_key_id: { from: 'access_key_id' },
				aws_secret_access_key: { from: 'secret_access_key' },
				aws_session_token: { from: 'session_token' }
			}
		},
		{
			kind: 'ini',
			path: '{state_dir}/aws/config',
			seed: '~/.aws/config',
			section: 'profile acct_444455556666',
			keys: { region: { value: 'us-east-1' } }
		},
		{
			kind: 'env',
			vars: {
				AWS_SHARED_CREDENTIALS_FILE: { value: '{state_dir}/aws/credentials' },
				AWS_CONFIG_FILE: { value: '{state_dir}/aws/config' }
			}
		}
	]
};

const GOOGLE_PROVIDER = 'projects/123456789/locations/global/workloadIdentityPools/github/providers/github';
const GOOGLE_SA = 'struct8-deploy@deft-landing-343414.iam.gserviceaccount.com';
const googleEntry = (own) => ({
	id: 'google-deft-landing-343414',
	provider: 'google',
	account: 'deft-landing-343414',
	own,
	method: 'oidc-gcp',
	inputs: { workload_identity_provider: GOOGLE_PROVIDER, service_account: GOOGLE_SA },
	deliver: [
		{ kind: 'file', path: '{state_dir}/google/google-deft-landing-343414.json', from: 'credential_json' },
		{
			kind: 'env',
			vars: { GOOGLE_APPLICATION_CREDENTIALS: { value: '{state_dir}/google/google-deft-landing-343414.json' } },
			unset: ['GOOGLE_CREDENTIALS', 'GOOGLE_CLOUD_KEYFILE_JSON', 'GCLOUD_KEYFILE_JSON', 'GOOGLE_OAUTH_ACCESS_TOKEN']
		}
	]
});

const cloudflareEntry = (account, own) => ({
	id: `cloudflare-${account}`,
	provider: 'cloudflare',
	account,
	own,
	method: 'secret',
	inputs: { secrets: { token: `AUTH_CLOUDFLARE_${account.toUpperCase()}` } },
	deliver: [{ kind: 'env', vars: { CLOUDFLARE_API_TOKEN: { from: 'token' } } }]
});

const stripeEntry = {
	id: 'stripe-acct_1abc',
	provider: 'stripe',
	account: 'acct_1abc',
	own: false,
	method: 'secret',
	inputs: {
		secrets: { key: 'AUTH_STRIPE_ACCT_1ABC' },
		checks: { key: { pattern: '^(sk|rk)_(test|live)_', expected: 'a Stripe secret or restricted key (sk_ or rk_)' } }
	},
	deliver: [{ kind: 'env', vars: { STRIPE_API_KEY: { from: 'key' } } }]
};

// ---------------------------------------------------------------------------
// Stand-ins.
// ---------------------------------------------------------------------------

const GITHUB_ENV = {
	ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.example/request?api-version=2.0',
	ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-bearer-123',
	GITHUB_RUN_ID: '777',
	CLOUDMAN_TRIGGERED_BY: 'rmay struct',
	AWS_PROFILE: 'left-on-the-runner'
};

function response(status, body) {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** fetch that answers GitHub, Google STS and IAM Credentials; `refuse` names one to refuse. */
function fakeFetch(calls, refuse = null) {
	return async (url, init = {}) => {
		calls.push({ url, init });
		if (url.startsWith('https://token.actions.example/')) {
			return refuse === 'github' ? response(403, {}) : response(200, { value: `jwt-for-${new URL(url).searchParams.get('audience')}` });
		}
		if (url === 'https://sts.googleapis.com/v1/token') {
			return refuse === 'sts'
				? response(400, { error_description: 'The given credential is rejected by the attribute condition.' })
				: response(200, { access_token: 'federated-token' });
		}
		if (url.includes('iamcredentials.googleapis.com')) {
			return refuse === 'impersonation'
				? response(403, { error: { message: 'Permission iam.serviceAccounts.getAccessToken denied' } })
				: response(200, { accessToken: 'service-account-token' });
		}
		return response(404, {});
	};
}

/** run() that answers `aws sts assume-role-with-web-identity` per role; `refuse` names a role ARN. */
function fakeRun(calls, refuse = null) {
	return (command, args, options = {}) => {
		const tokenArg = args[args.indexOf('--web-identity-token') + 1] ?? '';
		const tokenFile = tokenArg.replace(/^file:\/\//, '');
		calls.push({
			command,
			args,
			env: options.env,
			token: existsSync(tokenFile) ? readFileSync(tokenFile, 'utf-8') : null,
			tokenFile
		});
		const role = args[args.indexOf('--role-arn') + 1];
		if (role === refuse) {
			return { status: 254, stdout: '', stderr: 'An error occurred (AccessDenied) when calling the AssumeRoleWithWebIdentity operation: Not authorized to perform sts:AssumeRoleWithWebIdentity' };
		}
		const account = role.split(':')[4];
		return {
			status: 0,
			stdout: JSON.stringify({
				Credentials: {
					AccessKeyId: `ASIA${account}`,
					SecretAccessKey: `secret-${account}`,
					SessionToken: `session-${account}`,
					Expiration: '2026-11-14T13:00:00Z'
				}
			}),
			stderr: ''
		};
	};
}

function sandbox() {
	const root = mkdtempSync(path.join(os.tmpdir(), 'struct8-cred-test-'));
	const dirs = {
		home: path.join(root, 'home').replaceAll('\\', '/'),
		state_dir: path.join(root, 'state').replaceAll('\\', '/'),
		cred_dir: path.join(root, 'cred').replaceAll('\\', '/')
	};
	mkdirSync(`${dirs.home}/.aws`, { recursive: true });
	mkdirSync(dirs.state_dir, { recursive: true });
	writeFileSync(`${dirs.home}/.aws/credentials`, '[backend]\naws_access_key_id = BACKENDKEY\naws_secret_access_key = backend-secret\n');
	writeFileSync(`${dirs.home}/.aws/config`, '[profile backend]\nregion = sa-east-1\n');
	return { root, dirs };
}

async function signIn(entries, { secrets = {}, refuseFetch = null, refuseRole = null } = {}) {
	const { root, dirs } = sandbox();
	const fetchCalls = [];
	const runCalls = [];
	const lines = [];
	const result = await signInEntries({
		entries,
		secrets,
		dirs,
		ctx: {
			env: GITHUB_ENV,
			fetch: fakeFetch(fetchCalls, refuseFetch),
			run: fakeRun(runCalls, refuseRole),
			log: (line) => lines.push(line)
		}
	});
	const read = (file) => (existsSync(file) ? readFileSync(file, 'utf-8') : null);
	return { result, dirs, root, fetchCalls, runCalls, lines, read };
}

/** The variables env.sh exports, read the way bash would: `$(cat '<file>')`. */
function exported(dirs, read) {
	const script = read(`${dirs.state_dir}/env.sh`) ?? '';
	const out = {};
	for (const [, name, file] of script.matchAll(/^export ([A-Za-z_][A-Za-z0-9_]*)="\$\(cat '([^']+)'\)"$/gm)) {
		out[name] = read(file);
	}
	const unset = [...script.matchAll(/^unset ([A-Za-z_][A-Za-z0-9_]*)$/gm)].map((m) => m[1]);
	return { script, vars: out, unset };
}

// ---------------------------------------------------------------------------
// The entries.
// ---------------------------------------------------------------------------

console.log('▸ What an entry may hold');
{
	const valid = [awsOwn, awsForeign, googleEntry(false), cloudflareEntry('0a1b2c3d', false), stripeEntry];
	check('the entries of every cloud the app writes are accepted', validateEntries(valid, knownMethod).length === 0, validateEntries(valid, knownMethod).join('\n'));

	const unknown = validateEntries([{ ...cloudflareEntry('0a1b2c3d', true), method: 'oidc-oci' }], knownMethod);
	check('a method this engine does not have is named', unknown.some((e) => e.includes("'oidc-oci', which this engine does not have")), unknown.join('\n'));

	const variable = validateEntries(
		[{ ...cloudflareEntry('0a1b2c3d', true), deliver: [{ kind: 'variable', name: 'cf', from: 'token' }] }],
		knownMethod
	);
	check('a delivery this engine does not have is named', variable.some((e) => e.includes("'variable', which this engine does not have")), variable.join('\n'));

	const outside = validateEntries(
		[{ ...googleEntry(true), deliver: [{ kind: 'file', path: '/etc/credential.json', from: 'credential_json' }] }],
		knownMethod
	);
	check('a path outside the engine folders is refused', outside.some((e) => e.includes("outside the engine's folders")), outside.join('\n'));

	const climbing = validateEntries(
		[{ ...googleEntry(true), deliver: [{ kind: 'file', path: '{state_dir}/../x.json', from: 'credential_json' }] }],
		knownMethod
	);
	check('a path that climbs out with .. is refused', climbing.some((e) => e.includes("outside the engine's folders")), climbing.join('\n'));

	const placeholder = validateEntries(
		[{ ...cloudflareEntry('0a1b2c3d', true), deliver: [{ kind: 'env', vars: { X: { value: '{account}' } } }] }],
		knownMethod
	);
	check('a placeholder the engine does not fill is refused', placeholder.some((e) => e.includes('{account}')), placeholder.join('\n'));

	const twoOwn = validateEntries([awsOwn, { ...cloudflareEntry('0a1b2c3d', true) }], knownMethod);
	check('two entries of the own cloud are refused', twoOwn.some((e) => e.includes('one at most')), twoOwn.join('\n'));

	const repeated = validateEntries([awsForeign, awsForeign], knownMethod);
	check('a repeated id is refused', repeated.some((e) => e.includes('repeats the id')), repeated.join('\n'));
}

console.log('▸ Entries that write the same place');
{
	const twoCloudflare = collisions([cloudflareEntry('0a1b2c3d', true), cloudflareEntry('9f8e7d6c', false)]);
	check('two Cloudflare accounts collide on CLOUDFLARE_API_TOKEN', twoCloudflare.length === 1 && twoCloudflare[0].includes('CLOUDFLARE_API_TOKEN'), twoCloudflare.join('\n'));

	const twoGoogle = collisions([
		googleEntry(false),
		{ ...googleEntry(false), id: 'google-other-project', account: 'other-project', deliver: [
			{ kind: 'file', path: '{state_dir}/google/google-other-project.json', from: 'credential_json' },
			{ kind: 'env', vars: { GOOGLE_APPLICATION_CREDENTIALS: { value: '{state_dir}/google/google-other-project.json' } } }
		] }
	]);
	check('two Google projects collide on GOOGLE_APPLICATION_CREDENTIALS', twoGoogle.some((c) => c.includes('GOOGLE_APPLICATION_CREDENTIALS')), twoGoogle.join('\n'));

	const awsPair = collisions([awsOwn, awsForeign]);
	check('the own and a foreign AWS account do not collide: same file, different sections', awsPair.length === 0, awsPair.join('\n'));

	const sameSection = collisions([awsForeign, { ...awsForeign, id: 'aws-copy' }]);
	check('two entries writing one INI section collide', sameSection.some((c) => c.includes('[acct_444455556666]')), sameSection.join('\n'));
}

console.log('▸ INI sections');
{
	const base = '[backend]\naws_access_key_id = A\n\n[target]\naws_access_key_id = OLD\naws_session_token = OLD\n\n[other]\nx = 1\n';
	const replaced = replaceIniSection(base, 'target', [['aws_access_key_id', 'NEW']]);
	check('a section is replaced whole', replaced.includes('[target]\naws_access_key_id = NEW') && !replaced.includes('OLD'), replaced);
	check('the other sections stay', replaced.includes('[backend]\naws_access_key_id = A') && replaced.includes('[other]\nx = 1'), replaced);
	check('a new section goes at the end', replaceIniSection('', 'profile acct_1', [['region', 'us-east-1']]) === '[profile acct_1]\nregion = us-east-1\n');
	check('writing the same section twice gives the same file', replaceIniSection(replaced, 'target', [['aws_access_key_id', 'NEW']]) === replaced);
}

console.log('▸ The session name CloudTrail shows');
{
	check('a space becomes a dot and the run goes last', sessionName({ CLOUDMAN_TRIGGERED_BY: 'rmay struct', GITHUB_RUN_ID: '9' }, '') === 'rmay.struct-gh9');
	check('a bracket becomes a dot, without a trailing dot', sessionName({ GITHUB_ACTOR: 'struct8[bot]', GITHUB_RUN_ID: '9' }, '') === 'struct8.bot-gh9');
	check('another account is named after the user', sessionName({ CLOUDMAN_TRIGGERED_BY: 'ana', GITHUB_RUN_ID: '9' }, 'acct_444455556666') === 'ana-acct_444455556666-gh9');
	check('the name is cut at 64 characters', sessionName({ CLOUDMAN_TRIGGERED_BY: 'x'.repeat(80), GITHUB_RUN_ID: '123456789' }, 'acct_444455556666').length === 64);
}

// ---------------------------------------------------------------------------
// Sign-ins.
// ---------------------------------------------------------------------------

console.log('▸ Cloudflare and Stripe: a GitHub secret into a variable');
{
	const { result, dirs, read, lines, root } = await signIn([cloudflareEntry('0a1b2c3d', true), stripeEntry], {
		secrets: { AUTH_CLOUDFLARE_0A1B2C3D: 'cf-token-value-1', AUTH_STRIPE_ACCT_1ABC: 'sk_test_51abc' }
	});
	const { script, vars } = exported(dirs, read);
	check('signed in', result.code === 0, result.failure);
	check('CLOUDFLARE_API_TOKEN holds the token', vars.CLOUDFLARE_API_TOKEN === 'cf-token-value-1', JSON.stringify(vars));
	check('STRIPE_API_KEY holds the key', vars.STRIPE_API_KEY === 'sk_test_51abc', JSON.stringify(vars));
	check('no value is written in the script', !script.includes('cf-token-value-1') && !script.includes('sk_test_51abc'), script);
	check('the script removes the value files', script.trim().endsWith(`rm -rf -- '${dirs.state_dir}/env'`), script);
	check('both values are masked in the log', lines.includes('::add-mask::cf-token-value-1') && lines.includes('::add-mask::sk_test_51abc'), lines.join('\n'));
	check('no line of the log holds a value outside a mask', lines.filter((l) => !l.startsWith('::add-mask::')).every((l) => !l.includes('cf-token-value-1') && !l.includes('sk_test_51abc')), lines.join('\n'));
	if (process.platform !== 'win32') {
		check('the value files are readable by this user only', (statSync(`${dirs.state_dir}/env/CLOUDFLARE_API_TOKEN`).mode & 0o077) === 0);
	}
	rmSync(root, { recursive: true, force: true });
}
{
	const { result } = await signIn([cloudflareEntry('0a1b2c3d', true)], { secrets: { auth_cloudflare_0a1b2c3d: 'lower' } });
	check('a secret listed in other capitals is found', result.code === 0, result.failure);
}
{
	const { result } = await signIn([stripeEntry], { secrets: { AUTH_STRIPE_ACCT_1ABC: 'pk_test_51abc' } });
	check('a publishable Stripe key is refused with what was expected', result.code === 1 && result.failure.includes("does not hold a Stripe secret or restricted key (sk_ or rk_)"), result.failure);
	check('the refusal of a foreign account names it', result.failure.includes('This state also uses the stripe account acct_1abc'), result.failure);
}
{
	const { result } = await signIn([cloudflareEntry('0a1b2c3d', true)], { secrets: {} });
	check('a missing secret is named', result.code === 1 && result.failure.includes("secret 'AUTH_CLOUDFLARE_0A1B2C3D' was not found"), result.failure);
	check("the state's own refusal does not say 'also uses'", !result.failure.includes('also uses'), result.failure);
}

console.log('▸ AWS: the own account and another one, in files of this state');
{
	const { result, dirs, read, runCalls, lines, root } = await signIn([awsForeign, awsOwn]);
	const { vars, unset } = exported(dirs, read);
	const credentials = read(`${dirs.state_dir}/aws/credentials`) ?? '';
	const config = read(`${dirs.state_dir}/aws/config`) ?? '';
	check('signed in', result.code === 0, result.failure);
	check('the own account signs in first', runCalls[0]?.args.includes(ROLE_OWN), JSON.stringify(runCalls.map((c) => c.args)));
	check('the backend profile is kept in the state file', credentials.includes('[backend]\naws_access_key_id = BACKENDKEY'), credentials);
	check('[target] holds the own account', credentials.includes('[target]\naws_access_key_id = ASIA111122223333\naws_secret_access_key = secret-111122223333\naws_session_token = session-111122223333'), credentials);
	check('[acct_444455556666] holds the other account', credentials.includes('[acct_444455556666]\naws_access_key_id = ASIA444455556666'), credentials);
	check('the config names both regions', config.includes('[profile target]\nregion = us-east-1') && config.includes('[profile acct_444455556666]\nregion = us-east-1') && config.includes('[profile backend]'), config);
	check('the home files are not changed', read(`${dirs.home}/.aws/credentials`) === '[backend]\naws_access_key_id = BACKENDKEY\naws_secret_access_key = backend-secret\n');
	check('AWS_PROFILE is target, and the files are the state', vars.AWS_PROFILE === 'target' && vars.AWS_SHARED_CREDENTIALS_FILE === `${dirs.state_dir}/aws/credentials` && vars.AWS_CONFIG_FILE === `${dirs.state_dir}/aws/config`, JSON.stringify(vars));
	check('static AWS keys are unset', ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].every((n) => unset.includes(n)), unset.join(' '));
	check('the session names are the user, the scope and the run', runCalls[0]?.args.includes('rmay.struct-gh777') && runCalls[1]?.args.includes('rmay.struct-acct_444455556666-gh777'), JSON.stringify(runCalls.map((c) => c.args)));
	check('the GitHub token goes through a file, not the command line', runCalls.every((c) => c.token === 'jwt-for-sts.amazonaws.com' && !c.args.includes('jwt-for-sts.amazonaws.com')), JSON.stringify(runCalls.map((c) => c.args)));
	check('the token file is removed', runCalls.every((c) => !existsSync(c.tokenFile)));
	check('a profile left on the runner does not reach the CLI', runCalls.every((c) => c.env && !('AWS_PROFILE' in c.env)));
	check('the secret key and the session token are masked', ['secret-111122223333', 'session-111122223333', 'secret-444455556666'].every((v) => lines.includes(`::add-mask::${v}`)), lines.join('\n'));
	rmSync(root, { recursive: true, force: true });
}
{
	const { result } = await signIn([awsOwn, awsForeign], { refuseRole: ROLE_FOREIGN });
	check('a refused account stops the sign-in', result.code === 1, result.failure);
	check('the refusal names the account, the role and AWS reason', result.failure.includes(`could not sign in to AWS account 444455556666 as ${ROLE_FOREIGN}`) && result.failure.includes('AccessDenied'), result.failure);
	check('and says how to fix it, and which account it was', result.failure.includes('Connect that account to this GitOps workspace') && result.failure.includes('This state also uses the aws account 444455556666'), result.failure);
}

console.log('▸ Google Cloud: the credential file, proved before the plan');
{
	const { result, dirs, read, fetchCalls, root } = await signIn([googleEntry(true)]);
	const { vars, unset } = exported(dirs, read);
	const file = `${dirs.state_dir}/google/google-deft-landing-343414.json`;
	const credential = JSON.parse(read(file) ?? '{}');
	check('signed in', result.code === 0, result.failure);
	check('GOOGLE_APPLICATION_CREDENTIALS names the file', vars.GOOGLE_APPLICATION_CREDENTIALS === file, JSON.stringify(vars));
	check('the variables that come first in the provider order are unset', ['GOOGLE_CREDENTIALS', 'GOOGLE_OAUTH_ACCESS_TOKEN'].every((n) => unset.includes(n)));
	check('the file is an external_account credential', credential.type === 'external_account' && credential.audience === `//iam.googleapis.com/${GOOGLE_PROVIDER}`, JSON.stringify(credential));
	check('the file asks GitHub for a fresh token each time', credential.credential_source?.url === `${GITHUB_ENV.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(`https://iam.googleapis.com/${GOOGLE_PROVIDER}`)}`, credential.credential_source?.url);
	check('the file impersonates the service account', credential.service_account_impersonation_url?.endsWith(`${GOOGLE_SA}:generateAccessToken`));
	check('the sign-in was proved: GitHub, STS, then the service account', fetchCalls.map((c) => new URL(c.url).host).join(' ') === 'token.actions.example sts.googleapis.com iamcredentials.googleapis.com', fetchCalls.map((c) => c.url).join('\n'));
	rmSync(root, { recursive: true, force: true });
}
{
	const { result } = await signIn([googleEntry(false)], { refuseFetch: 'sts' });
	check('a refusal by the provider gives its reason and the condition to check', result.code === 1 && result.failure.includes('rejected by the attribute condition') && result.failure.includes('attribute condition has to accept'), result.failure);
	check('and names the foreign project', result.failure.includes('This state also uses the google account deft-landing-343414'), result.failure);
}
{
	const { result } = await signIn([{ ...googleEntry(true), inputs: { ...googleEntry(true).inputs, workload_identity_provider: 'projects/deft-landing-343414/locations/global/workloadIdentityPools/github/providers/github' } }]);
	check('a provider named by project ID instead of number is refused before any call', result.code === 1 && result.failure.includes("with the project's number, not its ID"), result.failure);
}

console.log('▸ Refusals before any sign-in');
{
	const { result, runCalls, fetchCalls } = await signIn([awsOwn, { ...cloudflareEntry('0a1b2c3d', false), method: 'oidc-oci' }]);
	check('an unknown method stops the state with code 2', result.code === 2 && result.failure.includes("'oidc-oci'"), result.failure);
	check('and nothing signed in', runCalls.length === 0 && fetchCalls.length === 0);
}
{
	const { result, runCalls } = await signIn([cloudflareEntry('0a1b2c3d', true), cloudflareEntry('9f8e7d6c', false)], {
		secrets: { AUTH_CLOUDFLARE_0A1B2C3D: 'a', AUTH_CLOUDFLARE_9F8E7D6C: 'b' }
	});
	check('two accounts in one variable stop the state with code 2', result.code === 2 && result.failure.includes('CLOUDFLARE_API_TOKEN') && result.failure.includes('One variable, section or file holds one account'), result.failure);
	check('and nothing signed in', runCalls.length === 0);
}

// ---------------------------------------------------------------------------
// The command line, as pipeline.sh calls it.
// ---------------------------------------------------------------------------

console.log('▸ The command line');
{
	const { root, dirs } = sandbox();
	const file = `${dirs.state_dir}/credentials.json`;
	writeFileSync(file, JSON.stringify([cloudflareEntry('0a1b2c3d', true)]));
	let code = 0;
	let stdout = '';
	try {
		stdout = execFileSync(process.execPath, [path.join(HERE, 'sign-in.mjs'), file, dirs.state_dir, dirs.cred_dir], {
			input: JSON.stringify({ AUTH_CLOUDFLARE_0A1B2C3D: 'cli-token-value' }),
			encoding: 'utf-8',
			env: { ...process.env, HOME: dirs.home }
		});
	} catch (error) {
		code = error.status ?? 1;
		stdout = String(error.stdout ?? '');
	}
	const read = (f) => (existsSync(f) ? readFileSync(f, 'utf-8') : null);
	check('the secrets come in on stdin and the state signs in', code === 0 && exported(dirs, read).vars.CLOUDFLARE_API_TOKEN === 'cli-token-value', stdout);
	check('the log shows the mask, never the bare value', stdout.includes('::add-mask::cli-token-value') && stdout.split('\n').filter((l) => !l.startsWith('::add-mask::')).every((l) => !l.includes('cli-token-value')), stdout);

	writeFileSync(file, JSON.stringify([{ ...cloudflareEntry('0a1b2c3d', true), method: 'oidc-oci' }]));
	code = 0;
	try {
		execFileSync(process.execPath, [path.join(HERE, 'sign-in.mjs'), file, dirs.state_dir, dirs.cred_dir], { input: '{}', encoding: 'utf-8' });
	} catch (error) {
		code = error.status ?? 1;
	}
	check('an unusable entry exits 2 and writes the reason for the app', code === 2 && (read(`${dirs.state_dir}/failure.txt`) ?? '').startsWith('Error: the credentials of this state cannot be used'));
	rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll credential cases pass.' : `\n${failures} credential case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
