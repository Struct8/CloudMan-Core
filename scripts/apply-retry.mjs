// scripts/apply-retry.mjs
//
// Decides whether a failed `terraform apply` is worth running once more, from
// the log the engine kept of it (./.struct8-live.log).
//
//   node apply-retry.mjs <logfile>
//
// Exit 0: every error Terraform printed is transient. One line on stdout names
//         the status and the resource, for the run log and the published
//         result.
// Exit 1: at least one error is not transient, or the log holds no Terraform
//         error at all. One line on stdout says which.
// Exit 2: the log could not be read.
//
// WHY. On 2026-11-19 (run 44633521264 of Struct8/CloudManV2CICD) Cloudflare
// accepted the PUT of five Workers custom domains and answered the GET the
// provider sends right after it with "404 Not Found". The state failed, and the
// same code applied cleanly on the next run. The provider (5.28.0) does not
// retry that read, and nothing in the engine did either: the person had to
// notice the failure and push again.
//
// WHAT COUNTS AS TRANSIENT. An HTTP status from TRANSIENT_STATUSES, read in an
// error Terraform printed:
//   404              a read right after a create, before the API shows what it
//                    just made (the case above);
//   429              a rate limit the provider's own retries did not outlast;
//   500 502 503 504  the API failed on its side.
// And, with no status at all, the network errors in TRANSIENT_TEXTS.
//
// WHAT IS LEFT OUT, ON PURPOSE.
//   409              A conflict can pass on its own, but on 2026-11-19 (run
//                    44639125819) it was a defect: the compile renamed a usage
//                    plan key, Terraform destroyed the old one and created the
//                    new one in parallel, and AWS refused the create while the
//                    old one existed. A second apply would likely have passed,
//                    and the rename would have gone on unseen.
//   400 401 403 422  An invalid value, a credential, a permission: the same
//                    answer on a second try, only later.
//   No status        Unknown, and unknown is not retried.
//
// ONLY THE ERROR DIAGNOSTICS ARE READ. The log carries everything the command
// printed before failing -- resource names, ids, addresses -- and a "404" in
// there means nothing. A status is read only inside a diagnostic that starts
// with "Error:", and only where an HTTP client writes one:
//   "404 Not Found"         the status line (Cloudflare, Azure);
//   "StatusCode: 404"       AWS SDK for Go v2;
//   "status code: 404"      AWS SDK for Go v1;
//   "StatusCode=404"        Azure autorest;
//   "googleapi: Error 404"  Google.
// The status line counts only with the standard phrase of its code, so
// "404 Not Found" is a status and "404 Gateway Timeout" is not.
//
// EVERY ERROR MUST QUALIFY. An apply prints one diagnostic per resource that
// failed. With a 404 and a 403 together, the 403 fails again whatever happens
// to the 404, so the apply is not retried.
//
// Warnings are skipped: they do not fail an apply.

import { readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';

const TRANSIENT_STATUSES = new Set([404, 429, 500, 502, 503, 504]);
const TRANSIENT_TEXTS = ['connection reset by peer', 'TLS handshake timeout'];

// Terraform's colors. The engine's log holds the escape byte itself; the log
// GitHub stores for the run (`gh run view --log`) writes it as the two
// characters "^[", and reading that one too is what lets a past run be checked
// against this script.
const ANSI = /(?:\x1b|\^\[)\[[0-9;?]*[A-Za-z]/g;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ERROR_PHRASES = Object.entries(STATUS_CODES)
	.filter(([code]) => Number(code) >= 400)
	.map(([, phrase]) => escapeRegExp(phrase))
	.join('|');
const STATUS_LINE = new RegExp(`\\b([45]\\d\\d) (${ERROR_PHRASES})(?![A-Za-z])`, 'g');

const STATUS_FIELDS = [
	/\bStatusCode[:=]\s*(\d{3})\b/g,
	/\bstatus code:\s*(\d{3})\b/gi,
	/\bgoogleapi: Error (\d{3})\b/g
];

// Each diagnostic as plain text, box drawing removed. With color, Terraform
// draws every diagnostic in a box: "╷" opens it, each line starts with "│",
// "╵" closes it. Without color there is no box, and a diagnostic runs from its
// "Error:" or "Warning:" line to the next one.
function diagnostics(text) {
	const lines = text.replace(ANSI, '').split(/\r?\n/);

	const boxes = [];
	let current = null;
	for (const line of lines) {
		if (line.startsWith('╷')) {
			current = [];
		} else if (line.startsWith('╵')) {
			if (current) boxes.push(current.join('\n'));
			current = null;
		} else if (current && line.startsWith('│')) {
			current.push(line.replace(/^│ ?/, ''));
		}
	}
	// A log cut before the closing line still holds the diagnostic.
	if (current && current.length) boxes.push(current.join('\n'));
	if (boxes.length) return boxes;

	const plain = [];
	for (const line of lines) {
		if (/^(Error|Warning): /.test(line)) plain.push([line]);
		else if (plain.length) plain[plain.length - 1].push(line);
	}
	return plain.map((group) => group.join('\n'));
}

function classify(diagnostic) {
	const first = diagnostic.split('\n').find((line) => line.trim() !== '') ?? '';
	if (!/^\s*Error:/.test(first)) return null;

	const statuses = new Set();
	for (const match of diagnostic.matchAll(STATUS_LINE)) {
		if (STATUS_CODES[match[1]] === match[2]) statuses.add(Number(match[1]));
	}
	for (const pattern of STATUS_FIELDS) {
		for (const match of diagnostic.matchAll(pattern)) statuses.add(Number(match[1]));
	}
	const text = TRANSIENT_TEXTS.find((t) => diagnostic.includes(t)) ?? null;

	return {
		title: first.replace(/^\s*Error:\s*/, '').trim(),
		address: diagnostic.match(/^\s*with ([^,\n]+),/m)?.[1] ?? null,
		statuses: [...statuses].sort((a, b) => a - b),
		text,
		transient: statuses.size
			? [...statuses].every((status) => TRANSIENT_STATUSES.has(status))
			: text !== null
	};
}

function describe(error) {
	let what;
	if (error.statuses.length) {
		what = error.statuses.map((status) => `${status} ${STATUS_CODES[status]}`).join(', ');
	} else if (error.text) {
		what = error.text;
	} else {
		what = `"${error.title}" (no HTTP status)`;
	}
	return error.address ? `${what} on ${error.address}` : what;
}

function verdict(text) {
	const errors = diagnostics(text).map(classify).filter(Boolean);
	if (!errors.length) return { retry: false, reason: 'no Terraform error in the log' };

	const blocking = errors.find((error) => !error.transient);
	if (blocking) return { retry: false, reason: `not transient: ${describe(blocking)}` };

	const more = errors.length - 1;
	return {
		retry: true,
		reason: describe(errors[0]) + (more ? ` and ${more} more transient error${more > 1 ? 's' : ''}` : '')
	};
}

const file = process.argv[2];
if (!file) {
	console.log('usage: node apply-retry.mjs <logfile>');
	process.exit(2);
}

let text;
try {
	text = readFileSync(file, 'utf-8');
} catch (error) {
	console.log(`could not read ${file}: ${error.message}`);
	process.exit(2);
}

const result = verdict(text);
console.log(result.reason);
process.exit(result.retry ? 0 : 1);
