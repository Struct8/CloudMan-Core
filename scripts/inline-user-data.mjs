// scripts/inline-user-data.mjs
//
// Puts the real user-data back into a generated import draft.
//
// THE PROBLEM. `aws_instance.user_data` is stored in state as the SHA1 of the
// content, never the content. `terraform plan -generate-config-out` writes
// state values, so the draft comes out as
//
//   user_data = "e05b46a5ed722f42eda8c33704ae9a7337712e20"
//
// which the provider then reads as if it WERE the content. A 40-character hex
// string is valid base64, so the provider's hash function decodes it to 30
// bytes of nothing and hashes those -- and the plan proposes replacing the
// instance's real user-data with the hash of that garbage.
//
// Removing the line does not help, and neither does `user_data_base64` nor
// `lifecycle { ignore_changes = [user_data] }`: all three still leave one
// changed attribute. Measured against a live instance, the only draft that
// plans as `1 to import, 0 to add, 0 to change, 0 to destroy` is the one
// carrying the actual script. So this reads it from the account and writes it
// in.
//
// WHY THIS IS NOT OPTIONAL for an account import: an instance that has
// user-data would otherwise arrive with a difference that never settles, and
// applying it would overwrite what the instance boots with.
//
// Usage:
//   node inline-user-data.mjs <config.tf> <plan.json>
//
// Exit codes: 0 = at least one instance was filled in, 1 = nothing to do or
// the account could not be asked. Either way the caller keeps going; a draft
// with the hash still in it is what today already produces.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [, , configPath, planPath] = process.argv;

if (!configPath || !fs.existsSync(configPath) || !planPath || !fs.existsSync(planPath)) {
	console.error('inline-user-data: usage: inline-user-data.mjs <config.tf> <plan.json>');
	process.exit(1);
}

/** What the generator writes in place of the content: a bare SHA1. */
const STATE_HASH = /^[0-9a-f]{40}$/;

let plan;
try {
	plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
} catch (e) {
	console.error(`inline-user-data: cannot read the plan file: ${e}`);
	process.exit(1);
}

const region =
	plan?.configuration?.provider_config?.aws?.expressions?.region?.constant_value ??
	process.env.AWS_REGION ??
	process.env.AWS_DEFAULT_REGION;

/** Instance id per `aws_instance` block name, for the ones being imported. */
const instances = new Map();
for (const rc of plan?.resource_changes ?? []) {
	if (rc?.type !== 'aws_instance') continue;
	const id = rc?.change?.importing?.id ?? rc?.change?.before?.id;
	if (typeof id === 'string' && id.startsWith('i-')) instances.set(rc.name, id);
}

if (instances.size === 0) {
	console.error('inline-user-data: no instance is being imported');
	process.exit(1);
}

/**
 * Reads one instance's user-data from the account.
 *
 * @param id the EC2 instance id
 * @returns the decoded content, or null when the instance has none
 */
function userDataOf(id) {
	const args = ['ec2', 'describe-instance-attribute', '--instance-id', id, '--attribute', 'userData', '--output', 'json'];
	if (region) args.push('--region', region);

	const out = execFileSync('aws', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
	const value = JSON.parse(out)?.UserData?.Value;
	if (typeof value !== 'string' || value === '') return null;
	return Buffer.from(value, 'base64').toString('utf-8');
}

/**
 * Renders a string as an HCL quoted literal.
 *
 * JSON escaping covers quotes, backslashes and newlines; `${` and `%{` are the
 * two sequences HCL reads as the start of an expression, and a shell script
 * that says `${IFACE}` would otherwise fail to parse or, worse, evaluate.
 *
 * @param text the content to embed
 */
function asHclString(text) {
	return JSON.stringify(text).replace(/\$\{/g, '$${').replace(/%\{/g, '%%{');
}

let source = fs.readFileSync(configPath, 'utf-8');
const eol = source.includes('\r\n') ? '\r\n' : '\n';
let filled = 0;

for (const [name, id] of instances) {
	// Bounded to this instance's own block, so a second instance in the same
	// file is not written with the first one's script. Generated config puts
	// every resource block at column zero, which is what closes the span.
	const header = `resource "aws_instance" "${name}" {`;
	const start = source.indexOf(header);
	if (start === -1) continue;
	const close = source.indexOf('\n}', start);
	if (close === -1) continue;
	const block = source.slice(start, close + 2);

	const line = /^([ \t]*)user_data(\s*=\s*)"([0-9a-f]{40})"[ \t]*$/m.exec(block);
	if (!line || !STATE_HASH.test(line[3])) continue;

	let content;
	try {
		content = userDataOf(id);
	} catch (e) {
		console.error(`inline-user-data: ${name} (${id}): could not read the account -- ${String(e).split('\n')[0]}`);
		continue;
	}
	if (content === null) continue;

	const replaced = block.replace(line[0], `${line[1]}user_data${line[2]}${asHclString(content)}`);
	source = source.slice(0, start) + replaced + source.slice(close + 2);
	filled++;
	console.log(`inline-user-data: ${name} (${id}) -> ${content.length} bytes of user-data`);
}

if (filled === 0) {
	console.error('inline-user-data: no instance needed it');
	process.exit(1);
}

fs.writeFileSync(configPath, source.replace(/\r?\n/g, eol), 'utf-8');
process.exit(0);
