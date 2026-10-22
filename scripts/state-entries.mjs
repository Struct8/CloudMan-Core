// scripts/state-entries.mjs
//
// Reads a Terraform state, as `terraform state pull` prints it, and answers the
// questions the engine asks about what a state holds.
//
//   provider-use <source>   What the state reaches through that provider's
//                           default configuration. Plain text, for bash: the
//                           first line holds the Cloudflare accounts named in
//                           the attributes (space-separated, possibly empty),
//                           each line after it one managed resource. Nothing at
//                           all when no managed resource uses the provider.
//   missing <addr>...       The addresses that name nothing in the state, one
//                           per line. Nothing when every one names something.
//   resolve <addr>...       JSON: the resource instances the addresses name.
//   list                    JSON: every resource instance.
//
// Usage:
//   terraform state pull | node state-entries.mjs provider-use registry.terraform.io/cloudflare/cloudflare
//   terraform state pull | node state-entries.mjs missing aws_s3_bucket.logs
//   terraform state pull | node state-entries.mjs resolve aws_s3_bucket.logs
//   terraform state pull | node state-entries.mjs list
//
// THE STATE NEVER TOUCHES THE DISK. It carries every attribute of every
// resource, secrets included, and it comes in on stdin. What goes out is a
// whitelist: address, mode, type, provider, id, and Cloudflare account
// identifiers. That is the same rule `_publish_state_manifest` follows for the
// file the app reads.
//
// PLAIN TEXT WHERE BASH READS THE ANSWER. The two answers pipeline.sh acts on
// are lines, so the shell needs no JSON parser to act on them, and the bash
// tests run without jq. The two that go into a published file are JSON, and
// jq places them there, as it does for every other file the engine publishes.
//
// WHY NOT `terraform show -json`. It renders values through the provider's
// schema, so every provider the state names has to be installed and able to
// start. This reads the state as data, which is what `terraform state rm` and
// the sign-in check need: both run exactly when a provider is the problem.
//
// Exit codes: 0 = answered, 1 = the input is not a state this understands.

import fs from 'node:fs';

const [, , command, ...args] = process.argv;

// The source and the alias out of `provider["registry.terraform.io/cloudflare/cloudflare"].alias`.
// A string in any other shape is kept whole as the source, so it still shows up
// in `providers` instead of vanishing.
function parseProvider(raw) {
	const match = /^provider\["([^"]+)"\](?:\.([A-Za-z0-9_-]+))?$/.exec(String(raw ?? ''));
	if (!match) return { source: String(raw ?? ''), alias: null };
	return { source: match[1], alias: match[2] ?? null };
}

// The instance's address as Terraform prints it in `state list`: module path,
// `data.` for a data source, type, name, then the index. A string key keeps its
// quotes (`aws_s3_bucket.b["logs"]`); a number does not (`aws_instance.a[0]`).
function instanceAddress(resource, instance) {
	const prefix = resource.module ? `${resource.module}.` : '';
	const mode = resource.mode === 'data' ? 'data.' : '';
	let index = '';
	if (instance && Object.prototype.hasOwnProperty.call(instance, 'index_key')) {
		const key = instance.index_key;
		if (typeof key === 'number') index = `[${key}]`;
		else if (typeof key === 'string') index = `[${JSON.stringify(key)}]`;
	}
	return `${prefix}${mode}${resource.type}.${resource.name}${index}`;
}

function entries(state) {
	const out = [];
	for (const resource of state.resources ?? []) {
		const provider = parseProvider(resource.provider);
		for (const instance of resource.instances ?? []) {
			const id = instance?.attributes?.id;
			out.push({
				address: instanceAddress(resource, instance),
				mode: resource.mode === 'data' ? 'data' : 'managed',
				type: resource.type,
				provider: provider.source,
				alias: provider.alias,
				id: typeof id === 'string' || typeof id === 'number' ? String(id) : null,
				attributes: instance?.attributes ?? {}
			});
		}
	}
	return out;
}

// Cloudflare account identifiers are 32 lowercase hex characters. The provider
// writes them as `account_id` on most resources, and as `account.id` on a zone
// in v5 -- which is where an AWS state that only wrote a DNS record finds one,
// because the record itself carries only the zone.
const CLOUDFLARE_ACCOUNT = /^[0-9a-f]{32}$/;

function cloudflareAccounts(attributes) {
	const found = [];
	const candidates = [attributes?.account_id, attributes?.account?.id];
	for (const value of candidates) {
		if (typeof value === 'string' && CLOUDFLARE_ACCOUNT.test(value)) found.push(value);
	}
	return found;
}

// The resources the next plan, apply or destroy has to reach through the
// DEFAULT configuration of one provider -- the one Terraform builds on its own,
// from the environment, when the code declares no `provider` block for it. An
// aliased configuration is left out: Terraform refuses to run without its block
// in the code, so no credential handed over here would help it. Data sources are
// left out too, because one the code no longer declares is dropped without a
// call; their attributes still count for the accounts.
function providerUse(state, source) {
	const managed = [];
	const accounts = new Set();
	for (const entry of entries(state)) {
		if (entry.provider !== source || entry.alias !== null) continue;
		if (entry.mode === 'managed') managed.push(entry.address);
		if (/(^|\/)cloudflare\/cloudflare$/.test(entry.provider)) {
			for (const account of cloudflareAccounts(entry.attributes)) accounts.add(account);
		}
	}
	if (managed.length === 0) return '';
	return [[...accounts].sort().join(' '), ...managed].join('\n') + '\n';
}

// Whether `terraform state rm <request>` would take `address`: the instance at
// that exact address, or any instance inside it -- a resource with `count` or
// `for_each` (`aws_instance.a` takes `aws_instance.a[0]` and `[1]`), or a whole
// module (`module.net` takes everything under it). The character after the
// request has to be `[` or `.`, so `aws_instance.a` never takes
// `aws_instance.ab`.
function takes(request, address) {
	if (address === request) return true;
	return address.startsWith(request) && ['[', '.'].includes(address.charAt(request.length));
}

function resolve(state, requests) {
	const all = entries(state);
	const matched = [];
	const taken = new Set();
	for (const request of requests) {
		for (const hit of all.filter((entry) => takes(request, entry.address))) {
			if (taken.has(hit.address)) continue;
			taken.add(hit.address);
			matched.push(identity(hit));
		}
	}
	return { serial: state.serial ?? null, lineage: state.lineage ?? null, matched };
}

function missing(state, requests) {
	const addresses = entries(state).map((entry) => entry.address);
	const gone = requests.filter((request) => !addresses.some((address) => takes(request, address)));
	return gone.length ? gone.join('\n') + '\n' : '';
}

function identity(entry) {
	return {
		address: entry.address,
		mode: entry.mode,
		type: entry.type,
		provider: entry.provider,
		id: entry.id
	};
}

function list(state) {
	return { serial: state.serial ?? null, lineage: state.lineage ?? null, resources: entries(state).map(identity) };
}

// `terraform state pull` prints nothing for a state that was never written.
// That is an empty state, not a broken one: every address in it is missing.
function readState() {
	const text = fs.readFileSync(0, 'utf-8');
	if (text.trim() === '') return { resources: [] };
	const state = JSON.parse(text);
	if (!state || typeof state !== 'object' || !Array.isArray(state.resources ?? [])) {
		throw new Error('not a Terraform state');
	}
	return state;
}

const ANSWERS = {
	'provider-use': (state) => providerUse(state, args[0] ?? ''),
	missing: (state) => missing(state, args),
	resolve: (state) => JSON.stringify(resolve(state, args)) + '\n',
	list: (state) => JSON.stringify(list(state)) + '\n'
};

if (!Object.prototype.hasOwnProperty.call(ANSWERS, command)) {
	console.error(
		'state-entries: usage: state-entries.mjs provider-use <source> | missing <address>... | resolve <address>... | list'
	);
	process.exit(1);
}

let state;
try {
	state = readState();
} catch (e) {
	console.error(`state-entries: could not read the state from stdin (${e.message}).`);
	process.exit(1);
}

process.stdout.write(ANSWERS[command](state));
