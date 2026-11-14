// scripts/credentials/entries.mjs
//
// The credential entries of a state (`credentials` in the manifest): what an
// entry may hold, which entries write the same place, and how each delivery is
// written.
//
// An entry is one account the state signs in to:
//
//   { "id": "aws-111122223333", "provider": "aws", "account": "111122223333",
//     "own": true, "method": "oidc-aws",
//     "inputs": { "role_arn": "...", "region": "us-east-1" },
//     "deliver": [ { "kind": "env", "vars": { "AWS_PROFILE": { "value": "target" } } } ] }
//
// The method (methods/<method>.mjs) turns the inputs into outputs, such as a
// token or a credential file. The deliveries say where each output goes, as
// data: an environment variable (`env`), a section of an INI file (`ini`) or a
// file (`file`). Nothing here knows a cloud, so a cloud whose method exists
// needs no change to the engine.
//
// A delivery writes only inside the engine's folders: `{state_dir}` (this
// state's, made per run), `{cred_dir}` (the run's) or the runner's home (`~/`).
// The app writes those placeholders; the engine fills them.

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class CredentialError extends Error {
	constructor(message) {
		super(message);
		this.name = 'CredentialError';
	}
}

export const DELIVERY_KINDS = ['env', 'ini', 'file'];

const METHOD_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// An id names files of the state (the OIDC token of oidc-aws), so it holds no
// slash and no `..`.
const ENTRY_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]|\.(?!\.)){0,99}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OUTPUT_NAME = /^[a-z][a-z0-9_]*$/;
const INI_KEY = /^[A-Za-z0-9_.-]+$/;
// `profile acct_111122223333` is a section of ~/.aws/config.
const INI_SECTION = /^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)?$/;
const PLACEHOLDER = /\{([a-z_]+)\}/g;
const ENGINE_PLACEHOLDERS = new Set(['state_dir', 'cred_dir']);

/** `{state_dir}`, `{cred_dir}` and a leading `~/` filled in. */
export function expand(text, dirs) {
	let out = String(text).replace(PLACEHOLDER, (whole, name) =>
		ENGINE_PLACEHOLDERS.has(name) ? dirs[name] : whole
	);
	if (out === '~' || out.startsWith('~/')) out = `${dirs.home}${out.slice(1)}`;
	return out;
}

function placeholderErrors(text, where) {
	const errors = [];
	for (const [, name] of String(text).matchAll(PLACEHOLDER)) {
		if (!ENGINE_PLACEHOLDERS.has(name)) {
			errors.push(`${where} uses the placeholder {${name}}, which this engine does not fill.`);
		}
	}
	return errors;
}

function pathErrors(value, where) {
	if (typeof value !== 'string' || value === '') return [`${where} names no path.`];
	const errors = placeholderErrors(value, where);
	const inside = ['{state_dir}/', '{cred_dir}/', '~/'].some((root) => value.startsWith(root));
	if (!inside || value.split('/').includes('..')) {
		errors.push(`${where} writes ${value}, outside the engine's folders.`);
	}
	return errors;
}

function sourceErrors(source, where) {
	if (!source || typeof source !== 'object' || Array.isArray(source)) {
		return [`${where} has no source.`];
	}
	const keys = Object.keys(source);
	if (keys.length === 1 && keys[0] === 'from' && OUTPUT_NAME.test(String(source.from))) return [];
	if (keys.length === 1 && keys[0] === 'value' && typeof source.value === 'string') {
		return placeholderErrors(source.value, where);
	}
	return [`${where} takes neither one output of the sign-in ("from") nor one value ("value").`];
}

function deliveryErrors(delivery, where) {
	if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
		return [`${where} is not an object.`];
	}
	const errors = [];
	switch (delivery.kind) {
		case 'env': {
			const vars = delivery.vars ?? {};
			if (typeof vars !== 'object' || Array.isArray(vars)) {
				errors.push(`${where} has no variables.`);
				break;
			}
			for (const [name, source] of Object.entries(vars)) {
				if (!ENV_NAME.test(name)) errors.push(`${where} names the variable '${name}'.`);
				errors.push(...sourceErrors(source, `${where}, variable ${name}`));
			}
			const unset = delivery.unset ?? [];
			if (!Array.isArray(unset) || unset.some((name) => !ENV_NAME.test(String(name)))) {
				errors.push(`${where} has an unset list that is not variable names.`);
			}
			if (Object.keys(vars).length === 0 && unset.length === 0) {
				errors.push(`${where} sets and unsets nothing.`);
			}
			break;
		}
		case 'ini': {
			errors.push(...pathErrors(delivery.path, `${where} (path)`));
			if (delivery.seed !== undefined) errors.push(...pathErrors(delivery.seed, `${where} (seed)`));
			if (!INI_SECTION.test(String(delivery.section ?? ''))) {
				errors.push(`${where} names the section '${delivery.section}'.`);
			}
			const keys = delivery.keys;
			if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length) {
				errors.push(`${where} has no keys.`);
				break;
			}
			for (const [key, source] of Object.entries(keys)) {
				if (!INI_KEY.test(key)) errors.push(`${where} names the key '${key}'.`);
				errors.push(...sourceErrors(source, `${where}, key ${key}`));
			}
			break;
		}
		case 'file':
			errors.push(...pathErrors(delivery.path, `${where} (path)`));
			if (!OUTPUT_NAME.test(String(delivery.from ?? ''))) {
				errors.push(`${where} names no output of the sign-in.`);
			}
			break;
		default:
			errors.push(`${where} asks for the delivery '${delivery.kind}', which this engine does not have.`);
	}
	return errors;
}

/**
 * Everything that keeps the entries from being used, one sentence each. Empty
 * when they can be. `knownMethod(name)` says whether the engine has the method.
 */
export function validateEntries(entries, knownMethod) {
	if (!Array.isArray(entries) || entries.length === 0) {
		return ['The credentials are not a list of entries.'];
	}
	const errors = [];
	const ids = new Set();
	let own = 0;
	entries.forEach((entry, i) => {
		const where = `Entry ${i + 1}${typeof entry?.id === 'string' && entry.id ? ` (${entry.id})` : ''}`;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			errors.push(`${where} is not an object.`);
			return;
		}
		if (typeof entry.id !== 'string' || entry.id === '') errors.push(`${where} has no id.`);
		else if (!ENTRY_ID.test(entry.id)) errors.push(`${where} has an id with characters other than letters, digits, ., _ and -.`);
		else if (ids.has(entry.id)) errors.push(`${where} repeats the id of another entry.`);
		else ids.add(entry.id);
		if (typeof entry.provider !== 'string' || entry.provider === '') {
			errors.push(`${where} names no provider.`);
		}
		if (entry.own === true) own++;
		if (typeof entry.method !== 'string' || !METHOD_NAME.test(entry.method)) {
			errors.push(`${where} names no sign-in method.`);
		} else if (!knownMethod(entry.method)) {
			errors.push(`${where} asks for the sign-in method '${entry.method}', which this engine does not have.`);
		}
		if (!entry.inputs || typeof entry.inputs !== 'object' || Array.isArray(entry.inputs)) {
			errors.push(`${where} has no inputs.`);
		}
		if (!Array.isArray(entry.deliver) || entry.deliver.length === 0) {
			errors.push(`${where} has no deliveries.`);
		} else {
			entry.deliver.forEach((delivery, j) => {
				errors.push(...deliveryErrors(delivery, `${where}, delivery ${j + 1}`));
			});
		}
	});
	if (own > 1) errors.push(`${own} entries are marked as the state's own cloud, and one at most can be.`);
	return errors;
}

/**
 * Pairs of entries that write the same place, one sentence each.
 *
 * Two entries may set the same variable to the same value: the AWS entries of
 * one state all point AWS_CONFIG_FILE at the state's file. A value taken from a
 * sign-in is that entry's own, so two entries that both take the token for
 * CLOUDFLARE_API_TOKEN collide: one variable holds one account. A section of an
 * INI file and a file belong to one entry.
 */
export function collisions(entries) {
	const claims = new Map();
	const found = [];
	const claim = (place, id, value) => {
		const prior = claims.get(place);
		if (!prior) {
			claims.set(place, { id, value });
		} else if (prior.id !== id && prior.value !== value) {
			found.push(`${prior.id} and ${id} both write ${place}.`);
		}
	};
	for (const entry of entries) {
		for (const delivery of entry.deliver ?? []) {
			if (delivery.kind === 'env') {
				for (const [name, source] of Object.entries(delivery.vars ?? {})) {
					const value = 'from' in source ? `from:${entry.id}:${source.from}` : `value:${source.value}`;
					claim(`the variable ${name}`, entry.id, value);
				}
			} else if (delivery.kind === 'ini') {
				claim(`the section [${delivery.section}] of ${delivery.path}`, entry.id, `entry:${entry.id}`);
			} else if (delivery.kind === 'file') {
				claim(`the file ${delivery.path}`, entry.id, `entry:${entry.id}`);
			}
		}
	}
	return found;
}

/** The value a source names: an output of the sign-in, or a value from the manifest. */
function valueOf(source, outputs, dirs, entry) {
	if ('from' in source) {
		if (typeof outputs[source.from] !== 'string') {
			throw new CredentialError(
				`Error: the ${entry.method} sign-in gave no '${source.from}', which a delivery of ${entry.id} takes.`
			);
		}
		return outputs[source.from];
	}
	return expand(source.value, dirs);
}

/** Writes <file> readable by this user only, through a temporary file and a rename. */
export function writePrivate(file, content) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, content, { mode: 0o600 });
	renameSync(temporary, file);
}

function sleep(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Holds <file>.lock while <work> runs. States of one run sign in at the same
 * time, and two of them may write sections of the same INI file.
 */
function withLock(file, work) {
	const lock = `${file}.lock`;
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	for (let waited = 0; ; waited += 50) {
		try {
			mkdirSync(lock);
			break;
		} catch (error) {
			if (error.code !== 'EEXIST' || waited >= 30000) {
				throw new CredentialError(`Error: could not lock ${file} to write a credential.`);
			}
			sleep(50);
		}
	}
	try {
		return work();
	} finally {
		rmdirSync(lock);
	}
}

/**
 * <text> with the section <section> replaced by <pairs>, or added at the end.
 * Every other line stays as it was.
 */
export function replaceIniSection(text, section, pairs) {
	const kept = [];
	let skipping = false;
	for (const line of text.split(/\r?\n/)) {
		const header = line.match(/^\s*\[(.+?)\]\s*$/);
		if (header) skipping = header[1].trim() === section;
		if (!skipping) kept.push(line);
	}
	while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
	const block = [`[${section}]`, ...pairs.map(([key, value]) => `${key} = ${value}`)];
	return `${kept.length ? `${kept.join('\n')}\n\n` : ''}${block.join('\n')}\n`;
}

function writeIniSection(file, seed, section, pairs) {
	for (const [key, value] of pairs) {
		if (/[\r\n]/.test(value)) {
			throw new CredentialError(`Error: the value for '${key}' in [${section}] of ${file} spans more than one line.`);
		}
	}
	withLock(file, () => {
		let text = '';
		if (existsSync(file)) text = readFileSync(file, 'utf-8');
		else if (seed && existsSync(seed)) text = readFileSync(seed, 'utf-8');
		writePrivate(file, replaceIniSection(text, section, pairs));
	});
}

/**
 * Writes the deliveries of <entry>. Variables are collected in <env>
 * ({ set: Map, unset: Set }) for the shell to export: a child process cannot
 * change its parent's environment.
 */
export function deliver(entry, outputs, dirs, env) {
	for (const delivery of entry.deliver) {
		if (delivery.kind === 'env') {
			for (const name of delivery.unset ?? []) {
				env.set.delete(name);
				env.unset.add(name);
			}
			for (const [name, source] of Object.entries(delivery.vars ?? {})) {
				env.unset.delete(name);
				env.set.set(name, valueOf(source, outputs, dirs, entry));
			}
		} else if (delivery.kind === 'file') {
			writePrivate(expand(delivery.path, dirs), valueOf({ from: delivery.from }, outputs, dirs, entry));
		} else if (delivery.kind === 'ini') {
			const pairs = Object.entries(delivery.keys).map(([key, source]) => [
				key,
				valueOf(source, outputs, dirs, entry)
			]);
			writeIniSection(
				expand(delivery.path, dirs),
				delivery.seed === undefined ? null : expand(delivery.seed, dirs),
				delivery.section,
				pairs
			);
		}
	}
}

/**
 * The script the shell sources: `unset` lines, then one `export` per variable
 * read from a file of its own, then the removal of those files. The values never
 * reach the script's text, the command line or the log.
 */
export function writeEnvScript(stateDir, env) {
	if (stateDir.includes("'")) throw new CredentialError(`Error: the state folder ${stateDir} has a quote in it.`);
	const valuesDir = `${stateDir}/env`;
	const lines = ['# Written by scripts/credentials/sign-in.mjs. Values are read from files.'];
	for (const name of [...env.unset].sort()) lines.push(`unset ${name}`);
	for (const [name, value] of [...env.set.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		writePrivate(`${valuesDir}/${name}`, value);
		lines.push(`export ${name}="$(cat '${valuesDir}/${name}')"`);
	}
	lines.push(`rm -rf -- '${valuesDir}'`);
	writePrivate(`${stateDir}/env.sh`, `${lines.join('\n')}\n`);
}

/** The lines GitHub hides from the log from now on, one per line of <value>. */
export function maskCommands(value) {
	return String(value)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length >= 4 && !/^-----(BEGIN|END) /.test(line))
		.map((line) => `::add-mask::${line}`);
}
