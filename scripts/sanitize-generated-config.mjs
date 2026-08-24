// scripts/sanitize-generated-config.mjs
//
// Makes `terraform plan -generate-config-out` output valid enough to plan.
//
// THE PROBLEM. Config generation is experimental, and the way it is wrong is
// systematic: it writes an entry for EVERY optional attribute in the schema, at
// the type's zero value, whether or not the account has one. The provider then
// rejects its own generator's output, because its validators read "present" as
// "the user asked for this":
//
//   ipv6_cidr_block = ""              -> "" is not a valid CIDR block
//   enable_lni_at_device_index = 0    -> must not be zero, got 0
//   availability_zone + _id both set  -> conflicts with each other
//   map_customer_owned_ip_on_launch   -> all of `..., outpost_arn` must be specified
//
// Measured on aws provider 5.100.0 reading a 12-resource VPC: 10 errors, and
// the plan file never written -- so the import draft reached the front end as
// the "validation errors, review by hand" placeholder, which is to say as
// nothing. This is not a provider 6 regression; 5.x does it too.
//
// WHAT THIS DOES. Two passes, in order of how much they assume:
//
//   1. STRUCTURAL, and it needs no catalogue of attribute names: an empty
//      string, list or map is not distinguishable from an absent attribute
//      here, so it goes. HOW it goes depends on what encloses it. Directly
//      under the resource, and inside a nested block, the line is dropped.
//      Inside an object-typed value -- `route = [{ ... }]` -- it becomes
//      `null`, because that object type declares every key, and dropping one
//      trades the CIDR error for "attributes ... are required". A tag map is
//      left alone: an empty tag value is a value, and removing it would make
//      the plan want to delete a tag off a live resource.
//
//   2. ERROR-DRIVEN: whatever survives, Terraform itself names. Each diagnostic
//      carries the resource address and the offending attribute, so the caller
//      re-runs Terraform, hands the log back, and this drops what was named.
//
//      WHY ASKING BEATS KNOWING. The rules being broken -- `ConflictsWith`,
//      `RequiredWith`, `ExactlyOneOf`, and every `validation.*` -- live in the
//      provider's Go structs and are published NOWHERE machine-readable. The
//      13 MB of `terraform providers schema -json` carries none of them: an
//      attribute there has type, optional, computed, required, sensitive,
//      deprecated, description and write_only, and that is all. So a rulebook
//      would have to be scraped from provider source and would rot on every
//      release, silently. The provider is the only complete authority, and it
//      speaks only in diagnostics.
//
//      AND ASKING IS FREE: those checks run in the SDK's schema validation,
//      before any API call, so `terraform validate` reports them all -- with no
//      credentials and no request to the account. That is what the caller
//      loops on. A `plan` is spent once, at the end, on what validation cannot
//      see: a value that differs from the account's.
//
// WHAT IT REFUSES TO DO is guess at zero-valued numbers and booleans in bulk.
// `source_dest_check = false` is what makes a NAT instance forward packets, and
// its schema default is true -- dropping it would silently undo the thing the
// instance exists for. Pass 2 removes a boolean only when the provider named it.
//
// Usage:
//   node sanitize-generated-config.mjs <config.tf>              # pass 1
//   node sanitize-generated-config.mjs <config.tf> <terraform.log> # pass 2
//
// Exit codes: 0 = the file was changed, 1 = nothing to change (or bad input).
// The caller uses that to stop looping instead of re-planning for no reason.

import fs from 'node:fs';

const [, , configPath, logPath] = process.argv;

if (!configPath || !fs.existsSync(configPath)) {
	console.error(`sanitize: no such config file: ${configPath}`);
	process.exit(1);
}

const original = fs.readFileSync(configPath, 'utf-8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.replace(/\r\n/g, '\n').split('\n');

/** `name = ""` / `[]` / `{}`, with the optional trailing comma of a list item. */
const EMPTY_ASSIGN = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*=\s*)(""|\[\]|\{\})(\s*,?\s*)$/;
/** `resource "aws_subnet" "public-nat-teste" {` */
const RESOURCE_OPEN = /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
/** The body of a heredoc is data, not HCL, and nothing here may touch it. */
const HEREDOC_OPEN = /<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/;
/** Maps whose keys are the account's own, not the schema's. */
const TAG_MAPS = new Set(['tags', 'tags_all', 'volume_tags']);

/**
 * What encloses a line, which is what decides whether it may be removed.
 *
 *   `block`   a nested block -- `root_block_device { ... }`, keys optional
 *   `objlist` an object-typed value -- `route = [{ ... }]`, every key required
 *   `map`     a tag map -- `tags = { ... }`, keys belong to the account
 *
 * @returns the kind this line opens, or null if it opens nothing
 */
function containerFor(line) {
	const assigned = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(\[\s*\{|\{)\s*$/.exec(line);
	if (assigned) {
		if (assigned[2].startsWith('[')) return 'objlist';
		// A bare `= {` is a tag map here. Anything else with that shape would be
		// an object type, and object types declare all their keys.
		return TAG_MAPS.has(assigned[1]) ? 'map' : 'objlist';
	}
	if (/^\s*[A-Za-z_][A-Za-z0-9_-]*\s*\{\s*$/.test(line)) return 'block';
	return null;
}

/**
 * Walks the file once, letting `decide` rewrite or drop each line inside a
 * resource block. Everything outside one is copied through untouched.
 *
 * @param decide (line, ctx) => string | null -- the line to keep, or null to drop
 * @returns the surviving lines and how many were changed
 */
function walk(decide) {
	const kept = [];
	let changed = 0;
	let heredoc = null;
	let address = null;
	const stack = [];

	for (const line of lines) {
		if (heredoc) {
			kept.push(line);
			if (line.trim() === heredoc) heredoc = null;
			continue;
		}

		const opened = RESOURCE_OPEN.exec(line);
		if (opened) {
			address = `${opened[1]}.${opened[2]}`;
			stack.length = 0;
			stack.push('resource');
			kept.push(line);
			continue;
		}

		if (address === null) {
			kept.push(line);
			continue;
		}

		const container = stack[stack.length - 1] ?? 'resource';
		const verdict = decide(line, { address, container });

		if (verdict === null) changed++;
		else {
			if (verdict !== line) changed++;
			kept.push(verdict);
			const opening = HEREDOC_OPEN.exec(verdict);
			if (opening) {
				heredoc = opening[1];
				continue;
			}
		}

		const nested = containerFor(line);
		if (nested) {
			stack.push(nested);
			continue;
		}
		// A closing line, and only a closing line: `}, {` continues a list of
		// objects and must leave the stack where it is.
		if (/^\s*[}\]]+\s*,?\s*$/.test(line)) {
			stack.pop();
			if (stack.length === 0) address = null;
		}
	}

	return { kept, changed };
}

/**
 * Removes what Terraform draws for a terminal, leaving the text.
 *
 * WITHOUT THIS, NOTHING BELOW MATCHES. Terraform colours a plan unless it is
 * given `-no-color`, and a redirected log keeps the escapes -- one real run
 * carried 541 of them. An `Error:` line arrives as
 *
 *   \x1b[31m│\x1b[0m \x1b[0m\x1b[1m\x1b[31mError: \x1b[0m...
 *
 * so any attempt to read it from the left stops inside `\x1b[31m`, on the `3`.
 *
 * `-no-color` would also fix the parsing, and was tried: it takes the colours
 * and the box away from the person reading the run, which is a worse trade than
 * stripping them here. The colours were never the defect.
 *
 * @param text raw log contents
 */
function stripDecoration(text) {
	return text.replace(/\r\n/g, '\n').replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * Reads a plan log and returns, per resource address, the attributes its
 * diagnostics blame.
 *
 * @param log the combined output of the failed `terraform plan`
 * @returns Map<"aws_subnet.name", Set<"availability_zone">>
 */
function attributesBlamedBy(log) {
	const doomed = new Map();

	// Grouped on the `Error:` lines themselves, not on the box Terraform draws
	// around a diagnostic: that frame is for a terminal and is absent from a
	// redirected log, and splitting on a character that is not there put every
	// attribute in the file onto whichever resource was blamed first.
	const groups = [];
	for (const line of stripDecoration(log).split('\n')) {
		const clean = line.replace(/^[\s│╵╷|]*/, '');
		if (/^(Error|Warning):/.test(clean)) groups.push([]);
		if (groups.length === 0) continue;
		// `on main.tf line 14, in resource "google_storage_bucket_object"
		// "conflito":` ends with the resource's own NAME in quotes and a colon --
		// the same shape as a blamed attribute, so it was being read as one and
		// dropped. A resource called `content` would have lost its `content`.
		//
		// The aws fixtures never showed this: their logical names carry hyphens,
		// which the attribute pattern excludes. It took running the same parser
		// against the google provider, whose names do not, to surface it.
		if (/^on\s+\S+\s+line\s+\d+/.test(clean)) continue;
		groups[groups.length - 1].push(clean);
	}

	for (const group of groups) {
		const body = group.join(' ');
		if (!/^Error:/.test(body)) continue;

		const at = /\bwith\s+([A-Za-z0-9_]+\.[A-Za-z0-9_-]+)\s*,/.exec(body);
		if (!at) continue;

		const attrs = new Set();

		// `"availability_zone": conflicts with ...`, `"ipv6_netmask_length": all
		// of ... must be specified`, `"source": only one of `content,source` can
		// be specified`. All four constraint families of the SDK quote the
		// offending attribute first -- the format strings are `%q: ...` in
		// helper/schema, so this is not provider-specific phrasing.
		//
		// Only the quoted one, never the other side: each side arrives as its own
		// diagnostic, so a pair is never dropped on one message.
		//
		// LIMIT, on `ExactlyOneOf`. Both sides do then get dropped, one per
		// diagnostic, and exactly one of them was required. The next round says
		// `one of ...` must be specified, nothing is left to drop, and the series
		// ends without a draft -- visibly, in the log, which is the failure this
		// is willing to have. It does not arise from a generated draft: config
		// generation fills one side with the account's value and the other with
		// the type's zero, and pass 1 removes the zero before this ever runs. A
		// draft with both sides really filled has not been seen.
		for (const m of body.matchAll(/"([a-z0-9_]+)"\s*:/g)) attrs.add(m[1]);

		// `Error: enable_lni_at_device_index must not be zero, got 0` -- a
		// validator on the attribute, which the SDK reports without quoting it.
		const zero = /^Error:\s*([a-z0-9_]+)\s+must not be zero/.exec(body);
		if (zero) attrs.add(zero[1]);

		// `expected private_dns_hostname_type_on_launch to be one of [...]`, and
		// the rest of the `validation.*` family, which name the attribute bare.
		// The generator emits the zero value of an enum as often as of anything
		// else, and an enum has no valid zero.
		const validated = /\bexpected\s+([a-z0-9_]+)\s+to be\b/.exec(body);
		if (validated) attrs.add(validated[1]);

		// Last resort: the source line Terraform echoes under the diagnostic.
		// Precise when present, and absent on the first run, where the file did
		// not exist yet when the plan started.
		if (attrs.size === 0) {
			const echoed = /\b\d+:\s+([a-z0-9_]+)\s*=/.exec(body);
			if (echoed) attrs.add(echoed[1]);
		}

		if (attrs.size === 0) continue;
		const already = doomed.get(at[1]) ?? new Set();
		for (const a of attrs) already.add(a);
		doomed.set(at[1], already);
	}

	return doomed;
}

let result;

if (!logPath) {
	// Pass 1: every empty string, list and map, placed by what encloses it.
	result = walk((line, ctx) => {
		const empty = EMPTY_ASSIGN.exec(line);
		if (!empty) return line;
		if (ctx.container === 'map') return line;
		if (ctx.container === 'objlist') {
			// Only the empty string has a validator to trip; an empty list or map
			// inside one of these objects is the type the schema asks for.
			return empty[4] === '""' ? `${empty[1]}${empty[2]}${empty[3]}null${empty[5]}` : line;
		}
		return null;
	});
	if (result.changed > 0) {
		console.log(`sanitize: cleared ${result.changed} empty-valued attribute(s)`);
	}
} else {
	// Pass 2: only what the provider itself named as the problem.
	if (!fs.existsSync(logPath)) {
		console.error(`sanitize: no such log file: ${logPath}`);
		process.exit(1);
	}
	const doomed = attributesBlamedBy(fs.readFileSync(logPath, 'utf-8'));
	if (doomed.size === 0) {
		console.error('sanitize: the plan errors name no attribute this can drop');
		process.exit(1);
	}

	for (const [address, attrs] of doomed) {
		console.log(`sanitize: ${address} -> dropping ${[...attrs].join(', ')}`);
	}

	result = walk((line, ctx) => {
		if (ctx.container !== 'resource') return line;
		// Dropping the line that OPENS a container would orphan its body.
		if (containerFor(line)) return line;
		const named = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/.exec(line);
		if (!named) return line;
		return doomed.get(ctx.address)?.has(named[1]) ? null : line;
	});
}

if (result.changed === 0) {
	console.error('sanitize: nothing left to drop');
	process.exit(1);
}

fs.writeFileSync(configPath, result.kept.join(eol), 'utf-8');
process.exit(0);
