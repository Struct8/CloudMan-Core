// scripts/credentials/sign-in.mjs
//
// Signs a state in to every account its manifest lists (`credentials`, one
// entry per account; see entries.mjs), and writes what the shell needs to use
// them. Called by `sign_in_credentials` in pipeline.sh:
//
//   printf '%s' "$SECRETS_CONTEXT" | node sign-in.mjs <credentials.json> <state_dir> <cred_dir>
//
// THE SECRETS COME IN ON STDIN. pipeline.sh keeps SECRETS_CONTEXT out of the
// environment of every child process, and this one is no exception: an
// environment variable would reach the `aws` and `az` it starts. Only the
// secrets an entry names leave this process, through the deliveries.
//
// Exit status:
//   0  signed in; <state_dir>/env.sh is the script to source.
//   1  a sign-in failed.
//   2  the entries cannot be used: a method or delivery this engine does not
//      have, a path outside its folders, two entries that write the same place.
// On 1 and 2, <state_dir>/failure.txt holds the reason, starting at an `Error:`
// line, for the file the app reads.
//
// ADDING A SIGN-IN METHOD. A file methods/<name>.mjs, and nothing else here or
// in pipeline.sh. It exports `required` (the input names it cannot do without)
// and `signIn(entry, ctx)`, which returns `{ outputs, secret }` or throws a
// CredentialError whose message starts at an `Error:` line. `outputs` maps names
// to strings; `secret` lists the outputs GitHub must hide from the log. ctx:
//   env      the environment, without the secrets
//   secrets  the GitHub secrets the workflow passed, by name
//   fetch    fetch()
//   run      run(command, args, { env }) -> { status, stdout, stderr }
//   workDir  a folder of this state, readable by this user only
//   log      prints a line to the run log; never a value

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	CredentialError,
	collisions,
	deliver,
	maskCommands,
	validateEntries,
	writeEnvScript,
	writePrivate
} from './entries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const METHOD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function methodPath(name) {
	return path.join(HERE, 'methods', `${name}.mjs`);
}

export function knownMethod(name) {
	return METHOD_NAME.test(String(name)) && existsSync(methodPath(name));
}

function defaultRun(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: 'utf-8',
		env: options.env ?? process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.error ? result.error.message : result.stderr ?? ''
	};
}

function failureText(entry, error) {
	const message =
		error instanceof CredentialError
			? error.message
			: `Error: the ${entry.method} sign-in stopped\n\n${error?.message ?? error}`;
	if (entry.own === true) return message;
	return `${message}\n\nThis state also uses the ${entry.provider} account ${entry.account ?? entry.id}, and this was that account's sign-in.`;
}

/**
 * Signs in every entry, the state's own first. Returns { code } and, when the
 * code is not 0, the failure text. `ctx` replaces env, fetch, run and log in the
 * tests.
 */
export async function signInEntries({ entries, secrets, dirs, ctx = {} }) {
	const errors = validateEntries(entries, knownMethod);
	if (errors.length) {
		return { code: 2, failure: `Error: the credentials of this state cannot be used\n\n${errors.join('\n')}` };
	}
	const found = collisions(entries);
	if (found.length) {
		return {
			code: 2,
			failure: `Error: two credentials of this state write the same place\n\n${found.join('\n')}\nOne variable, section or file holds one account.`
		};
	}

	const log = ctx.log ?? ((line) => console.log(line));
	const context = {
		env: ctx.env ?? process.env,
		secrets: secrets ?? {},
		fetch: ctx.fetch ?? globalThis.fetch,
		run: ctx.run ?? defaultRun,
		workDir: dirs.state_dir,
		log
	};
	const env = { set: new Map(), unset: new Set() };
	const ordered = [...entries.filter((e) => e.own === true), ...entries.filter((e) => e.own !== true)];

	for (const entry of ordered) {
		const who = `${entry.provider} ${entry.account ?? entry.id}`;
		log(`🔑 ${entry.own === true ? "The state's cloud" : 'Also'}: ${who} (${entry.method})`);
		try {
			const method = await import(pathToFileURL(methodPath(entry.method)).href);
			const missing = (method.required ?? []).filter((name) => {
				const value = entry.inputs[name];
				return value === undefined || value === null || value === '';
			});
			if (missing.length) {
				throw new CredentialError(`Error: the ${entry.provider} sign-in received no ${missing.join(', ')}.`);
			}
			const { outputs = {}, secret = [] } = await method.signIn(entry, context);
			for (const name of secret) {
				if (typeof outputs[name] === 'string') maskCommands(outputs[name]).forEach((line) => log(line));
			}
			deliver(entry, outputs, dirs, env);
		} catch (error) {
			return { code: 1, failure: failureText(entry, error) };
		}
	}

	try {
		writeEnvScript(dirs.state_dir, env);
	} catch (error) {
		return { code: 1, failure: `Error: could not write the credentials of this state\n\n${error.message}` };
	}
	return { code: 0 };
}

function readSecrets() {
	try {
		const raw = readFileSync(0, 'utf-8');
		const parsed = raw.trim() ? JSON.parse(raw) : {};
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function main([credentialsFile, stateDir, credDir]) {
	if (!credentialsFile || !stateDir || !credDir) {
		console.error('usage: node sign-in.mjs <credentials.json> <state_dir> <cred_dir>');
		return 2;
	}
	const secrets = readSecrets();
	let entries;
	try {
		entries = JSON.parse(readFileSync(credentialsFile, 'utf-8'));
	} catch (error) {
		writePrivate(`${stateDir}/failure.txt`, `Error: the credentials of this state are not JSON\n\n${error.message}\n`);
		return 2;
	}
	const result = await signInEntries({
		entries,
		secrets,
		dirs: { state_dir: stateDir, cred_dir: credDir, home: os.homedir() }
	});
	if (result.code !== 0) writePrivate(`${stateDir}/failure.txt`, `${result.failure}\n`);
	return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main(process.argv.slice(2));
}
