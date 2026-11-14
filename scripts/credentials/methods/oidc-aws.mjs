// scripts/credentials/methods/oidc-aws.mjs
//
// Trades this job's GitHub OIDC token for temporary AWS credentials
// (AssumeRoleWithWebIdentity), the sign-in auth_aws does in scripts/auth/aws.sh.
//
// inputs:
//   role_arn       the role to assume, Struct8-Gitops-<owner>-<repo> in the account
//   region         picks the STS endpoint
//   session_scope  optional, added to the session name: `acct_<account>` for an
//                  account other than the state's own
//
// outputs: access_key_id, secret_access_key, session_token, expiration.

import { rmSync } from 'node:fs';
import { CredentialError, writePrivate } from '../entries.mjs';
import { githubOidcToken } from '../github-oidc.mjs';

export const required = ['role_arn', 'region'];

const ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@/-]+$/;

/**
 * The session name, which CloudTrail shows as the user name: the Struct8 user
 * who started the run, then the scope, then the run. The same rules as
 * auth_aws: AWS accepts 2 to 64 characters of [\w+=,.@-], and `-` separates the
 * fields, so everything else becomes a dot.
 */
export function sessionName(env, scope) {
	let actor = String(env.CLOUDMAN_TRIGGERED_BY || env.GITHUB_ACTOR || 'CloudMan').replace(/[^A-Za-z0-9_+=,.@]/g, '.');
	while (actor.includes('..')) actor = actor.replaceAll('..', '.');
	actor = actor.replace(/^\./, '').replace(/\.$/, '').slice(0, 48) || 'CloudMan';
	const suffix = scope ? `-${scope}` : '';
	return `${actor}${suffix}-gh${env.GITHUB_RUN_ID || 0}`.slice(0, 64);
}

export async function signIn(entry, ctx) {
	const { role_arn: roleArn, region, session_scope: scope } = entry.inputs;
	const match = ROLE_ARN.exec(String(roleArn ?? ''));
	if (!match) {
		throw new CredentialError(`Error: the AWS sign-in received '${roleArn}', which is not an IAM role ARN.`);
	}
	const account = match[1];
	const jwt = await githubOidcToken('sts.amazonaws.com', ctx);

	// The token goes through a file, not the command line, so it does not show
	// in the runner's process list.
	const tokenFile = `${ctx.workDir}/${entry.id}.oidc-token`;
	writePrivate(tokenFile, jwt);
	let result;
	try {
		// A profile left in the environment would make the CLI look for it, and
		// this call needs no credential at all.
		const env = { ...ctx.env };
		delete env.AWS_PROFILE;
		delete env.AWS_DEFAULT_PROFILE;
		result = ctx.run(
			'aws',
			[
				'sts',
				'assume-role-with-web-identity',
				'--role-arn',
				roleArn,
				'--role-session-name',
				sessionName(ctx.env, scope),
				'--web-identity-token',
				`file://${tokenFile}`,
				'--duration-seconds',
				'3600',
				'--region',
				String(region),
				'--output',
				'json'
			],
			{ env }
		);
	} finally {
		rmSync(tokenFile, { force: true });
	}

	let credentials = null;
	if (result.status === 0) {
		try {
			credentials = JSON.parse(result.stdout).Credentials;
		} catch {
			credentials = null;
		}
	}
	if (!credentials?.AccessKeyId || !credentials?.SecretAccessKey || !credentials?.SessionToken) {
		const reason = String(result.stderr || result.stdout || '').trim() || 'AWS gave no reason.';
		const advice = entry.own
			? ''
			: '\nConnect that account to this GitOps workspace before deploying a state that uses resources in it.';
		throw new CredentialError(`Error: could not sign in to AWS account ${account} as ${roleArn}\n\n${reason}${advice}`);
	}
	return {
		outputs: {
			access_key_id: credentials.AccessKeyId,
			secret_access_key: credentials.SecretAccessKey,
			session_token: credentials.SessionToken,
			expiration: String(credentials.Expiration ?? '')
		},
		secret: ['secret_access_key', 'session_token']
	};
}
