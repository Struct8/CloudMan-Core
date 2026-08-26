// scripts/prune-missing-imports.mjs
//
// Removes import blocks for objects the account no longer has.
//
// THE GAP THIS EXISTS FOR. The import blocks come from a scan, and the scan is
// a snapshot. Between the person picking resources and the import running,
// something can be deleted -- by an autoscaler, by a colleague, by a pipeline.
// Terraform then answers
//
//   Error: Cannot import non-existent remote object
//   While attempting to import an existing object to "aws_instance.x", the
//   provider detected that no object exists with the given id.
//
// and stops. Not for that resource: for the whole run. One instance that went
// away takes down the draft of the other eleven, and the front end receives the
// "validation errors" placeholder, which reads as "nothing found".
//
// So the block goes, and the rest of the account gets drafted. WHAT THIS DOES
// NOT DO is hide it: the resources that survive are fewer than the ones asked
// for, and the front end compares those two numbers and stops on the
// difference. Removing the block is what turns "everything failed for a reason
// buried in a log" into "these two are gone, here is the rest".
//
// Usage:
//   node prune-missing-imports.mjs <imports.tf> <plan.log>
//
// Exit codes: 0 = at least one block was removed, 1 = none to remove.

import fs from 'node:fs';

const [, , importsPath, logPath] = process.argv;

if (!importsPath || !fs.existsSync(importsPath) || !logPath || !fs.existsSync(logPath)) {
	console.error('prune-missing-imports: usage: prune-missing-imports.mjs <imports.tf> <plan.log>');
	process.exit(1);
}

// The colour codes go first, and they are not cosmetic here: Terraform colours
// a plan unless told not to, a redirected log keeps every escape, and the
// address this looks for sits right after one of them. One real run carried 541.
const log = fs
	.readFileSync(logPath, 'utf-8')
	.replace(/\r\n/g, '\n')
	.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');

// The diagnostic is wrapped at the terminal width and framed with box-drawing
// characters, so the address is read off the whole text rather than off any one
// line.
const flattened = log
	.split('\n')
	.map((line) => line.replace(/^[\s│╵╷|]*/, ''))
	.join(' ');

const missing = new Set();
for (const m of flattened.matchAll(
	/attempting to import an existing object to\s+"([A-Za-z0-9_]+\.[A-Za-z0-9_-]+)"/g
)) {
	missing.add(m[1]);
}

if (missing.size === 0) {
	console.error('prune-missing-imports: no import names an object that is gone');
	process.exit(1);
}

const original = fs.readFileSync(importsPath, 'utf-8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.replace(/\r\n/g, '\n').split('\n');

const kept = [];
const removed = [];
let block = null;

for (const line of lines) {
	if (block === null) {
		if (/^\s*import\s*\{/.test(line)) {
			block = [line];
			continue;
		}
		kept.push(line);
		continue;
	}

	block.push(line);
	if (!/^\s*\}\s*$/.test(line)) continue;

	const body = block.join(' ');
	const to = /\bto\s*=\s*([A-Za-z0-9_]+\.[A-Za-z0-9_-]+)/.exec(body);
	const id = /\bid\s*=\s*"([^"]*)"/.exec(body);

	if (to && missing.has(to[1])) removed.push(`${to[1]} (${id?.[1] ?? 'no id'})`);
	else kept.push(...block);

	block = null;
}

// An unterminated block is not ours to judge; put it back as it was.
if (block !== null) kept.push(...block);

if (removed.length === 0) {
	console.error('prune-missing-imports: the missing objects have no block in this file');
	process.exit(1);
}

for (const name of removed) console.log(`prune-missing-imports: gone from the account, dropped -> ${name}`);

fs.writeFileSync(importsPath, kept.join(eol), 'utf-8');
process.exit(0);
