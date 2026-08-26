// scripts/complete-lambda-source.mjs
//
// Gives an imported `aws_lambda_function` the code location the provider
// demands and the account cannot answer.
//
// THE PROBLEM. `aws_lambda_function` requires exactly one of `filename`,
// `image_uri` or `s3_bucket` in configuration. None of them describes the
// function as it exists: AWS returns a presigned download URL for the current
// package, never the bucket, key or path it was uploaded from. So config
// generation writes all three at the empty string, the sanitizer clears all
// three as empty, and the provider then says one of them must be specified --
// about a function that is running fine.
//
// Measured on 2026-08-26, importing a five-resource account: the plan closed
// with `3 to import` and the function was one of the two left out, while the
// run reported success.
//
// WHAT THIS DOES. Writes `filename` pointing at a placeholder archive, and
// tells Terraform to ignore both it and the hash derived from it:
//
//   filename = "imported_lambda_placeholder.zip"
//   lifecycle {
//     ignore_changes = [filename, source_code_hash]
//   }
//
// WHAT THAT MEANS, and it is worth being exact because it is a real limit: the
// import captures the function's CONFIGURATION -- memory, timeout, runtime,
// handler, environment, the role it assumes -- and not its code. `apply` will
// not touch the running package. Anyone removing `ignore_changes` later, with
// the placeholder still in place, replaces live code with an empty archive.
//
// WHY A PLACEHOLDER AND NOT THE REAL PACKAGE. Downloading it would put the
// customer's code, and whatever is bundled with it, into a Git repository they
// did not choose to store it in. That is a decision for whoever owns the code,
// not a side effect of drawing a diagram.
//
// AND IT IS NOT THE END STATE. Compiling the diagram back to HCL runs
// `transformHcl` in the catalogue's `aws_lambda_function/import.js`, which
// replaces `filename` with a `data "archive_file"` built from
// `.external_modules/LambdaFiles/<name>`. The placeholder exists so the draft
// can be planned at all; what the customer ends up applying comes from there.
//
// Usage:
//   node complete-lambda-source.mjs <config.tf>
//
// Exit codes: 0 = the file was changed, 1 = nothing to do (or bad input).

import fs from 'node:fs';
import path from 'node:path';

const [, , configPath] = process.argv;

if (!configPath || !fs.existsSync(configPath)) {
	console.error(`lambda-source: no such config file: ${configPath}`);
	process.exit(1);
}

/** The archive `filename` points at. Written beside the config, not committed. */
const PLACEHOLDER = 'imported_lambda_placeholder.zip';

/** The three attributes the provider accepts as a code location, one required. */
const SOURCES = ['filename', 'image_uri', 's3_bucket'];

const original = fs.readFileSync(configPath, 'utf-8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.replace(/\r\n/g, '\n').split('\n');

/** `resource "aws_lambda_function" "processor" {` */
const LAMBDA_OPEN = /^resource\s+"aws_lambda_function"\s+"([^"]+)"\s*\{/;
/** `filename = "..."`, captured with its value so an empty one can be told apart. */
const ASSIGN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * A value that says nothing. The generator writes `""` for an attribute the
 * account did not answer for, and the sanitizer may already have removed it --
 * both mean the same thing here.
 */
const isEmpty = (value) => {
	const v = value.trim().replace(/,$/, '');
	return v === '""' || v === 'null' || v === '';
};

const out = [];
let changed = 0;
const completed = [];

for (let i = 0; i < lines.length; i++) {
	const opened = LAMBDA_OPEN.exec(lines[i]);
	if (!opened) {
		out.push(lines[i]);
		continue;
	}

	// Read the whole resource before deciding: a code location further down the
	// block is still a code location, and rewriting on the first line seen would
	// add a second one.
	const body = [];
	let depth = 1;
	let j = i + 1;
	for (; j < lines.length && depth > 0; j++) {
		for (const ch of lines[j]) {
			if (ch === '{' || ch === '[') depth++;
			else if (ch === '}' || ch === ']') depth--;
		}
		if (depth > 0) body.push(lines[j]);
		else break;
	}
	// An unterminated block is not this script's to guess at.
	if (depth > 0) {
		out.push(lines[i]);
		continue;
	}

	// TOP LEVEL ONLY. `environment { variables = { filename = ... } }` is a map
	// the customer owns, and a key of that name there says nothing about where
	// the code lives.
	let level = 0;
	let hasSource = false;
	const kept = [];
	for (const line of body) {
		const named = level === 0 ? ASSIGN.exec(line) : null;
		const isSourceLine = named && SOURCES.includes(named[1]);
		if (isSourceLine && !isEmpty(named[2])) hasSource = true;
		// The empty ones go: one of them is about to be written with a value, and
		// leaving the other two at `""` trips the same rule from the other side.
		if (!isSourceLine || !isEmpty(named[2])) kept.push(line);
		else changed++;

		for (const ch of line) {
			if (ch === '{' || ch === '[') level++;
			else if (ch === '}' || ch === ']') level--;
		}
	}

	out.push(lines[i]);
	if (hasSource) {
		// Nothing to complete: the draft already names where the code is. The
		// empty siblings still go -- left at `""` they read as a second code
		// location, which is the error this exists to avoid, from the other side.
		out.push(...kept);
	} else {
		out.push(`  filename = "${PLACEHOLDER}"`);
		out.push('  lifecycle {');
		out.push('    ignore_changes = [filename, source_code_hash]');
		out.push('  }');
		out.push(...kept);
		changed++;
		completed.push(opened[1]);
	}
	out.push(lines[j]);
	i = j;
}

if (changed === 0) {
	console.error('lambda-source: no function needed a code location');
	process.exit(1);
}

// An empty ZIP: the end-of-central-directory record and nothing else, which is
// what every reader treats as an archive with no entries. It exists so the
// provider can hash something at plan time; `ignore_changes` keeps that hash
// from ever reaching the account.
const emptyZip = Buffer.from([
	0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
]);
if (completed.length) {
	fs.writeFileSync(path.join(path.dirname(path.resolve(configPath)), PLACEHOLDER), emptyZip);
}

fs.writeFileSync(configPath, out.join(eol), 'utf-8');

for (const name of completed) {
	console.log(
		`lambda-source: aws_lambda_function.${name} -> placeholder archive; its code is not managed here`
	);
}
process.exit(0);
