#!/usr/bin/env node
//
// Lists one region of one account and writes `scan_inventory.json`, which
// Struct8 turns into a diagram.
//
// It answers WHAT EXISTS -- an identifier and a name -- and nothing else.
// Reading configuration is the next step's job, and that step is Terraform,
// because only the provider knows how to put an attribute into Terraform's
// shape. A hand-written state built from cloud API responses would carry the
// field names of the API (`CidrBlock`) instead of the ones Terraform expects
// (`cidr_block`); that difference is the whole reason this script stops at
// identity.
//
// TWO LAYERS, and the second is why this is not just one API call:
//
//   1. Resources with a listing API. Cloud Control is asked once per resource
//      type, from the list Struct8 sends -- one uniform call, no per-resource
//      code. The network family is asked separately, by `vpc-id`, because it
//      needs an anchor Cloud Control has no way to express.
//
//   2. Children that live INSIDE a parent's answer. An ACL entry has no listing
//      API and no ARN -- it is a row in `describe-network-acls`. Those cost no
//      extra call: they are expanded out of the parent's response, and each
//      carries the composite id Terraform imports it by.
//
// WHAT THIS SCRIPT DOES NOT KNOW: any CloudMan type name. It answers in AWS's own
// vocabulary -- `AWS::Lambda::Function` and an identifier -- and Struct8 decides
// what that maps to, because Struct8 is what holds the catalog. Adding a resource
// to the catalog changes nothing in this file.
//
// CREDENTIALS. Whatever the caller already set up. `pipeline.sh` runs this after
// PASSO 2, with `AWS_PROFILE=target` exported, so the AWS CLI reaches the account
// being scanned. The Cloud Control calls no longer go through the CLI, so they
// read that same profile themselves (`lib/cloud-control.mjs`) -- the static keys
// `auth_aws` wrote there, not a role assumed per call.
//
// SCOPE. Read from `scan_scope.json` in the working directory, which Struct8
// pushes next to the manifest. Command-line flags override it, which is what
// makes the script runnable by hand while debugging.
//
// Usage:
//   node scan-account.mjs [--region us-east-1] [--out scan_inventory.json]
//                         [--vpc vpc-0703...] [--tag Project=k8hub]
//                         [--type AWS::Lambda::Function ...] [--request-id abc]

import { execFileSync, execFile } from 'node:child_process';
import { cloudControl, resolveCredentials } from './lib/cloud-control.mjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const allOf = (name) =>
	args.reduce((acc, a, i) => (a === `--${name}` ? [...acc, args[i + 1]] : acc), []);

// The scope file is the normal source; a missing or broken one is not fatal, so
// that running this by hand with just `--region` behaves the same way.
let scope = {};
try {
	scope = JSON.parse(fs.readFileSync('scan_scope.json', 'utf-8'));
} catch {
	scope = {};
}

const region = argOf('region') || scope.region || process.env.AWS_REGION || null;
const outPath = argOf('out', 'scan_inventory.json');
const vpcIds = allOf('vpc').length ? allOf('vpc') : (scope.vpcIds ?? []);
const tagFilters = allOf('tag').length ? allOf('tag') : (scope.tagFilters ?? []);
// The types to sweep. Struct8 sends them because Struct8 is what owns the
// catalog -- this script deliberately knows no CloudMan type names, so that a
// resource added to the catalog costs nothing here.
const cfnTypes = allOf('type').length ? allOf('type') : (scope.cfnTypes ?? []);
// The subset of those worth reading one by one, to learn what each USES. Struct8
// sends it because only the catalog knows which types can become a node -- asking
// every swept row would be one call per resource in the account.
const cfnDetailTypes = allOf('detail').length ? allOf('detail') : (scope.cfnDetailTypes ?? []);
// Echoed into the answer, and that is its whole job.
//
// `scan_inventory.json` sits at a fixed path, so the file the PREVIOUS scan wrote
// is still there while this one runs -- complete, valid, and indistinguishable
// from the one being waited for. Struct8 polls that path, and on 2026-08-26 it
// picked up the old file and moved on to the selection screen while the sweep was
// still going, offering resources from a scan the person had already replaced.
//
// So the answer carries the id of the request that asked for it, and Struct8
// ignores an answer that is not the one it asked for.
const requestId = argOf('request-id') || scope.requestId || null;

if (!region) {
	console.error('scan-account: no region -- not in scan_scope.json, --region or AWS_REGION.');
	process.exit(2);
}

const errors = [];

/**
 * One AWS CLI call. A failure is recorded and the scan continues.
 *
 * `expected` marks failures that are not news, and the type sweep below cannot
 * work without it: of the ~770 AWS resource types, a couple hundred have no LIST
 * handler at all. Recording one error each would bury the handful a person can
 * actually act on under three hundred that mean "this type never lists, for
 * anyone" -- and would make a complete scan read as a broken one.
 */
function aws(service, operation, extra = [], expected = null) {
	try {
		const out = execFileSync(
			'aws',
			[service, operation, '--region', region, '--output', 'json', ...extra],
			{ encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
		);
		return JSON.parse(out);
	} catch (error) {
		// Recorded, never fatal: one service the credentials cannot read must not
		// cost the other forty. Struct8 shows this list next to what was found, so
		// a partial scan is never mistaken for a complete one.
		const message = String(error?.stderr ?? error?.message ?? error).slice(0, 400);
		if (expected && expected(message)) return null;
		errors.push({ source: `${service} ${operation}`, message });
		return null;
	}
}

/**
 * Rate limiting, from the message the answer carried.
 *
 * Module scope because BOTH wide passes need it: the type sweep and the detail
 * read. It lived inside the sweep until 2026-08-26, which is part of why the
 * detail read had no retry -- the ladder was not reachable from there.
 */
const isThrottle = (message) => /Throttl|Rate exceeded|TooManyRequests/i.test(message);

/**
 * Credentials for the in-process Cloud Control client, read once.
 *
 * Resolved lazily and remembered, including the failure: without credentials
 * every one of the several hundred calls would record the same error, and a scan
 * that reports one problem three hundred times is harder to act on than one that
 * reports it once. The scan still finishes and still writes its file -- a partial
 * answer is reported as partial, never as empty.
 */
let credentialsOnce;
function credentialsOrNull() {
	if (credentialsOnce === undefined) {
		try {
			credentialsOnce = resolveCredentials();
		} catch (error) {
			credentialsOnce = null;
			errors.push({ source: 'cloudcontrol', message: String(error?.message ?? error) });
		}
	}
	return credentialsOnce;
}

/**
 * One Cloud Control call, in this process rather than through the AWS CLI.
 *
 * WHY NOT `aws cloudcontrol`. A scan makes roughly 870 of these, and each `aws`
 * invocation spent 478 ms starting Python before it sent anything -- measured
 * 2026-09-06 with `aws --version`, which touches no network, against a complete
 * call at 1341 ms. The same call through this path takes 847 ms.
 *
 * The proof it was local cost and not the network: time PER CALL used to rise
 * with the pool width (1341 ms alone, 2101 at width 10, 3499 at width 30). It no
 * longer does, which is what lets the two passes below overlap.
 *
 * `expected` and the `errors` shape are unchanged, and so is the text a failure
 * carries -- `cloud-control.mjs` reproduces the CLI's `<Exception>: <message>`
 * exactly so that every regex reading it keeps working.
 */
async function cloudControlAsync(operation, payload, expected = null) {
	const credentials = credentialsOrNull();
	const source = `cloudcontrol ${operation === 'ListResources' ? 'list-resources' : 'get-resource'}`;
	if (!credentials) return null;

	const answer = await cloudControl(operation, payload, { region, credentials });
	if (answer.ok) return answer.value;
	if (expected && expected(answer.message)) return null;
	errors.push({ source, message: answer.message.slice(0, 400) });
	return null;
}

/**
 * The same CLI call, off the main thread, so many can be in flight at once.
 *
 * Cloud Control does not come through here any more, and what is left would not
 * justify this on its own except for one loop: the bucket location. S3 lists
 * every bucket in the account whatever region is asked, and each one has to be
 * asked where it lives -- 50 in this account, and asking them one at a time was
 * about a minute of the scan spent on a question with a one-word answer.
 */
function awsAsync(service, operation, extra = [], expected = null) {
	return new Promise((resolve) => {
		execFile(
			'aws',
			[service, operation, '--region', region, '--output', 'json', ...extra],
			{ encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const message = String(stderr || error?.message || error).slice(0, 400);
					if (expected && expected(message)) return resolve(null);
					errors.push({ source: `${service} ${operation}`, message });
					return resolve(null);
				}
				try {
					resolve(JSON.parse(stdout));
				} catch {
					errors.push({ source: `${service} ${operation}`, message: 'answer was not JSON' });
					resolve(null);
				}
			}
		);
	});
}

/**
 * Runs `worker` over `list`, `width` at a time.
 *
 * A fixed pool rather than `Promise.all` over everything: asking Cloud Control
 * four hundred questions at once only converts into throttling, which costs a
 * backoff wait per call and buys no throughput.
 */
async function inParallel(list, width, worker) {
	const queue = [...list];
	const runners = Array.from({ length: Math.min(width, queue.length) }, async () => {
		while (queue.length) await worker(queue.shift());
	});
	await Promise.all(runners);
}

const items = [];
// Returns the row it added: the sweep hands its own rows to the detail read as
// soon as that type finishes listing, and needs to know which ones are its.
const push = (arn, extra = {}) => {
	const item = { arn, ...extra };
	items.push(item);
	return item;
};
const tagsOf = (list) =>
	Object.fromEntries((list ?? []).map((t) => [t.Key ?? t.key, t.Value ?? t.value]));

// ------------------------------- the detail read, running DURING the sweep
//
// WHY IT STARTS HERE instead of after the sweep, where it reads. The two passes
// ask different Cloud Control operations, and those have separate rate capacity
// -- measured 2026-09-06 on 60 types and 60 roles: 12.3 s for the listings alone,
// 14.7 s for the reads alone, and 16.0 s for both at once, against 27.1 s one
// after the other. Waiting for the whole sweep to end before reading anything
// spent that difference for nothing.
//
// Nothing else moves. A type's rows are handed over the moment THAT type finishes
// listing, so the read never sees a half-listed type, and the counting, the
// narrowing ladder and the reference matching all still happen below, after every
// read is in.
const wantedDetail = new Set(cfnDetailTypes);

/**
 * The one type held back from the overlap.
 *
 * S3 answers the whole account whatever region is asked, and which buckets belong
 * to this scan is decided by `get-bucket-location` further down. Handing them over
 * as they list would spend a read on every bucket in the account and then drop
 * most of the answers -- so these are queued after that filter instead, which is
 * the same set the pass read before it overlapped anything.
 */
const DETAIL_AFTER_REGION = new Set(['AWS::S3::Bucket']);

/**
 * How many unread candidates are named one by one.
 *
 * A COUNT WITH NO NAMES CANNOT BE CHECKED. `no longer there: 1` came back
 * identical from two scans half an hour apart, which is not what a resource
 * disappearing mid-scan looks like -- something answers LIST and then refuses to
 * be read, every time, and there was no way to find out what. The names are
 * capped because an account with a permissions problem can produce hundreds of
 * these, and this file is read by a browser.
 */
const UNREAD_NAMED = 20;

/** Why a read failed, in the words of whoever has to act on it. */
const reasonFor = (message) => {
	if (isThrottle(message)) return 'rate limited';
	if (/AccessDenied|not authorized|UnauthorizedOperation/i.test(message)) return 'not allowed';
	if (/NotFound|does not exist/i.test(message)) return 'no longer there';
	return 'refused';
};

const unreadBy = new Map();
const unreadWho = [];
/** Every ARN a candidate's own configuration names, and who named it. */
const namedBy = new Map();
const throttledRows = [];
let unread = 0;
let detailAsked = 0;

/**
 * Reads one candidate and records what its configuration names.
 *
 * RATE LIMITING IS THE COMMON FAILURE HERE, not a resource that cannot be read.
 * Measured on 2026-08-26: 55 of 78 reads came back empty on a real account, and
 * because every failure counted as expected, the run reported one error and
 * looked healthy. What was lost was this pass's whole purpose -- the function in
 * the test account never named its role, so the role stayed indistinguishable
 * from the account's other 248 and nobody selected it.
 *
 * So a throttled read comes back for a narrower pass, the same ladder the sweep
 * uses, and whatever is still unread afterwards is counted BY REASON and
 * reported. Silence was the actual defect; a number nobody can see is the same
 * defect with extra steps.
 */
const readOne = async (row, onThrottle) => {
	const answer = await cloudControlAsync(
		'GetResource',
		{ TypeName: row.cfnType, Identifier: String(row.importId) },
		(message) => {
			if (onThrottle && isThrottle(message)) {
				onThrottle(row);
				return true;
			}
			// A resource that cannot be read individually costs its references and
			// nothing else -- the row itself already came from the listing and stays.
			unread++;
			const reason = reasonFor(message);
			unreadBy.set(reason, (unreadBy.get(reason) ?? 0) + 1);
			if (unreadWho.length < UNREAD_NAMED) {
				unreadWho.push({ cfnType: row.cfnType, importId: String(row.importId), reason });
			}
			return true;
		}
	);
	// Properties arrive as a JSON STRING inside the answer, not as an object.
	const properties = answer?.ResourceDescription?.Properties;
	if (typeof properties !== 'string') return;
	const names = new Set(properties.match(/arn:aws[a-z-]*:[^"\\\s,\]]+/g) ?? []);

	// Not every reference is an ARN. A KMS alias names its key by a bare id
	// (`TargetKeyId`), and the same holds wherever AWS uses a plain identifier.
	// So every string VALUE in the answer is offered too, matched whole against
	// what the sweep found -- values, not a search through the text, because a
	// substring hit would tie together resources that merely share a prefix.
	try {
		const walk = (value) => {
			if (typeof value === 'string') {
				if (value.length >= 8) names.add(value);
			} else if (Array.isArray(value)) {
				value.forEach(walk);
			} else if (value && typeof value === 'object') {
				Object.values(value).forEach(walk);
			}
		};
		walk(JSON.parse(properties));
	} catch {
		// Properties that will not parse still gave up their ARNs above.
	}

	for (const name of names) {
		if (!namedBy.has(name)) namedBy.set(name, new Set());
		namedBy.get(name).add(String(row.importId));
	}
};

/**
 * A pool that reads whatever has been handed to it, and stops when the sweep says
 * there will be no more.
 *
 * `inParallel` cannot do this: it takes a finished list, and the whole point here
 * is that the list is still being written. Width 8 is what the pass used before
 * overlapping, kept because the constraint is Cloud Control's rate and not this
 * machine -- measured the same day, widening the sweep from 8 to 20 made it
 * SLOWER, because the extra calls came back throttled and each one then waited
 * out a backoff.
 */
const detailQueue = [];
const detailWaiters = [];
let detailInputOpen = cfnDetailTypes.length > 0;

function handToDetail(rows) {
	for (const row of rows) {
		if (row.cfnType && wantedDetail.has(row.cfnType)) {
			detailQueue.push(row);
			detailAsked++;
		}
	}
	while (detailWaiters.length) detailWaiters.pop()();
}

function closeDetailInput() {
	detailInputOpen = false;
	while (detailWaiters.length) detailWaiters.pop()();
}

const detailPool = Promise.all(
	Array.from({ length: detailInputOpen ? 8 : 0 }, async () => {
		for (;;) {
			if (!detailQueue.length) {
				if (!detailInputOpen) return;
				await new Promise((resolve) => detailWaiters.push(resolve));
				continue;
			}
			const row = detailQueue.shift();
			try {
				await readOne(row, (r) => throttledRows.push(r));
			} catch (error) {
				// One row that blows up must not take the pool down with it: this
				// promise is awaited much later, so a rejection here would surface as
				// an unhandled one long after the row that caused it, and the reads
				// still queued would never happen. Recorded like any other failure.
				errors.push({
					source: `cloudcontrol get-resource ${row?.cfnType ?? '?'}`,
					message: String(error?.message ?? error).slice(0, 400)
				});
			}
		}
	})
);

// -------------------------------------------- layer 1a: every type, by its LIST
//
// The Cloud Control API answers one question for any resource type: what exists.
// `--type-name` is the only thing that differs between one type and the next, so
// sweeping four hundred types is the same code as sweeping four. There is no
// per-resource handler anywhere in this path, which is the whole point: a type
// new to AWS costs a line in a list, not code here.
//
// WHY IT REPLACED THE TAGGING API. That index only answers for resources that
// carry a tag, and an account built by hand in the console carries none. Measured
// in mx-central-1 on 2026-08-25, against a bucket, a table, a function, a role and
// a log group created without tags: the tagging index answered with two EC2
// instances DESTROYED hours earlier, and none of the five that existed. One
// source, two failures -- blind to the living, still reporting the dead.
//
// The `Identifier` this returns IS the Terraform import id, in the shape
// `terraform import` expects. Nothing downstream has to rebuild it from an ARN.
//
// STILL DELIBERATELY GENEROUS about what is alive. This script reports what the
// account answers; deciding what is still usable belongs to the AgentV2 status
// read, which Struct8 runs over this inventory before showing the selection list
// (`scanLiveness.ts`, in the frontend). This file briefly did that itself, by
// asking EC2 which instances were in an importable state. It worked for instances
// and only for instances -- the next dead thing to stop an import was a subnet,
// and the fix would have been a second hand-written check, then a third.
{
	if (!cfnTypes.length) {
		errors.push({
			source: 'cloudcontrol list-resources',
			message:
				'No type list to sweep: `cfnTypes` was absent from scan_scope.json and no --type was passed. ' +
				'Only the network layer was read.'
		});
	}

	// A type with no LIST handler, and one that refuses without a parent id, are
	// both normal across a sweep this wide -- they are properties of the type, not
	// of this account. Counted, not recorded one by one; see `aws()` above.
	let skipped = 0;
	const notNews = (message) => {
		if (
			/does not support LIST|UnsupportedActionException|TypeNotFoundException/i.test(message) ||
			/required key \[|Missing Or Invalid ResourceModel|Missing or invalid ResourceModel/i.test(
				message
			)
		) {
			skipped++;
			return true;
		}
		return false;
	};

	// ------------------- the two types AWS fills with its own catalogue
	//
	// Cloud Control answers "what exists", and for these two most of what exists
	// belongs to AWS rather than to the account. Measured 2026-09-06 in
	// 952133486861/us-west-2: of 1667 managed policies, 1574 were
	// `arn:aws:iam::aws:policy/...`, and all 826 SSM documents were AWS's. Together
	// they were 2493 of the 3232 rows a scan carried -- paged in over 38 calls and
	// then discarded downstream by the rule that drops the literal `aws` account.
	//
	// Cloud Control has no owner filter, so the question is asked of the service
	// that does. `iam list-policies --scope Local` answers the 93 that are really
	// this account's, in one call; `ssm list-documents` with `Owner=Self` answers
	// the customer's, in one call.
	//
	// THIS IS A DELIBERATE EXCEPTION, and a narrow one. The rule of this script is
	// that a type costs a line in a list and never code
	// (`docs/importacao-varredura-da-conta.md`), which is why this is a table with
	// two rows and not two handlers: what varies is an operation and two field
	// names, and a third type would be a third row. A type NOT in this table keeps
	// the uniform path, and a row whose call fails falls back to it -- the
	// optimisation degrades to the old behaviour instead of losing resources.
	const CUSTOMER_ONLY_LIST = {
		'AWS::IAM::ManagedPolicy': {
			service: 'iam',
			operation: 'list-policies',
			args: ['--scope', 'Local'],
			rows: 'Policies',
			identifier: 'Arn'
		},
		'AWS::SSM::Document': {
			service: 'ssm',
			operation: 'list-documents',
			args: ['--filters', 'Key=Owner,Values=Self'],
			rows: 'DocumentIdentifiers',
			identifier: 'Name'
		}
	};

	const answeredByOwnerFilter = new Set();
	for (const [type, how] of Object.entries(CUSTOMER_ONLY_LIST)) {
		if (!cfnTypes.includes(type)) continue;
		const answer = aws(how.service, how.operation, how.args);
		// Left to the sweep on failure: fewer resources than the account holds is
		// the one outcome worth avoiding, and a slower complete answer beats a fast
		// incomplete one.
		if (!answer) continue;
		const mine = [];
		for (const row of answer[how.rows] ?? []) {
			const id = row[how.identifier];
			if (id) mine.push(push(null, { cfnType: type, importId: String(id) }));
		}
		answeredByOwnerFilter.add(type);
		handToDetail(mine);
	}
	const sweepTypes = cfnTypes.filter((type) => !answeredByOwnerFilter.has(type));

	// CONCURRENT, and it is not an optimisation. Measured on 2026-08-25: 478 types
	// asked one after another did not finish inside ten minutes, and the panel
	// waiting on this run gives up at twenty.
	//
	// WIDTH 10 IS NOT A CEILING TO RAISE. It used to be limited by this machine --
	// each call was an `aws` child process, and the time per call rose with the
	// width. With the calls made in this process that is gone, and what is left is
	// Cloud Control's own rate: measured 2026-09-06 over the same 80 types, width 8
	// took 17.6 s, width 12 took 18.9 s and width 20 took 26.6 s. Past the limit the
	// extra calls come back throttled and each one waits out a backoff, so asking
	// harder makes the scan slower and never finds more.
	//
	// Rate limiting is expected, not a failure. A throttled call now backs off and
	// retries in place (`cloud-control.mjs`); the narrowing ladder below is what
	// catches whatever survives that. A type still throttled after both IS reported
	// -- silently returning fewer resources than the account holds is the one
	// outcome worth failing over, because half a diagram looks exactly like a whole
	// one.
	const throttled = [];

	/**
	 * What each type contributed, so a retry can take it back.
	 *
	 * A throttle breaks out of the pagination loop with the earlier pages already
	 * in `items`, and the ladder then restarts that type from its first page.
	 * Without this the type appears twice, and with the detail read now consuming
	 * these rows it would also be read twice.
	 */
	const sweptByType = new Map();

	async function sweep(type, onThrottle) {
		const earlier = sweptByType.get(type);
		if (earlier?.length) {
			const drop = new Set(earlier);
			for (let i = items.length - 1; i >= 0; i--) if (drop.has(items[i])) items.splice(i, 1);
		}
		const mine = [];
		sweptByType.set(type, mine);

		let token = null;
		let complete = false;
		do {
			const page = await cloudControlAsync(
				'ListResources',
				token ? { TypeName: type, NextToken: token } : { TypeName: type },
				(message) => {
					if (onThrottle && isThrottle(message)) {
						onThrottle(type);
						return true;
					}
					return notNews(message);
				}
			);
			if (!page) break;
			for (const row of page.ResourceDescriptions ?? []) {
				// No ARN: Cloud Control does not answer one. The type and the import id
				// are what the frontend needs, and they are both here.
				if (row.Identifier) mine.push(push(null, { cfnType: type, importId: row.Identifier }));
			}
			token = page.NextToken || null;
			complete = !token;
		} while (token);

		// Handed to the read only once the LISTING of this type is finished. A type
		// that stopped halfway is a type whose rows are not all here, and the ladder
		// is about to ask it again from the first page.
		if (complete && !DETAIL_AFTER_REGION.has(type)) handToDetail(mine);
	}

	await inParallel(sweepTypes, 10, (type) => sweep(type, (t) => throttled.push(t)));

	// NARROWING, not one retry. A single second pass still left nine types unread
	// on a real sweep, and each unread type is a set of resources the person is
	// never offered -- which looks exactly like an account that does not have them.
	// Each round halves the width, so the last one is nearly serial.
	for (let width = 4; width >= 1 && throttled.length; width = Math.floor(width / 2)) {
		const again = throttled.splice(0, throttled.length);
		console.error(`scan-account: ${again.length} type(s) rate limited -- asking again, ${width} at a time.`);
		await inParallel(again, width, (type) => sweep(type, width > 1 ? (t) => throttled.push(t) : null));
	}

	if (skipped) {
		console.error(`scan-account: ${skipped} type(s) have no usable LIST -- expected, not an error.`);
	}
}

// --------------------------------------- layer 1a-bis: the tagging API, on ask
//
// It survives for one reason: it is the only call that can answer "which
// resources carry this tag", and `tagFilters` is a scope input. It is no longer
// the default path, so its two defects -- silent about the untagged, still
// answering for the destroyed -- only reach someone who asked for a tag filter.
if (tagFilters.length) {
	const extra = ['--resources-per-page', '100'];
	for (const filter of tagFilters) {
		const [key, value] = String(filter).split('=');
		extra.push('--tag-filters', value ? `Key=${key},Values=${value}` : `Key=${key}`);
	}

	let token = null;
	do {
		const page = aws(
			'resourcegroupstaggingapi',
			'get-resources',
			token ? [...extra, '--pagination-token', token] : extra
		);
		if (!page) break;
		for (const row of page.ResourceTagMappingList ?? []) {
			push(row.ResourceARN, { tags: tagsOf(row.Tags) });
		}
		token = page.PaginationToken || null;
	} while (token);
}

// ------------------------------------------- layer 1a-ter: S3 answers globally
//
// `--region` filters every regional type on its own -- measured: the lab function
// in mx-central-1 does not appear when listing us-east-1 or sa-east-1. S3 is the
// exception that matters: its LIST returns every bucket in the account whatever
// region is asked, and the answer carries only the name. So the region has to be
// asked per bucket, and buckets elsewhere dropped -- otherwise scanning one
// region drags in the whole account's storage.
//
// THE QUIRK THAT WOULD EAT THEM SILENTLY: a bucket in us-east-1 answers a null
// LocationConstraint, not the region name. Reading null as "no region" loses every
// us-east-1 bucket without a word.
//
// IAM is global too and is deliberately NOT filtered: a role has no region at all,
// and dropping it would break the very function being imported alongside it.
{
	// CONCURRENT because the count is the account's, not this scan's: every bucket
	// gets asked, and only then is it known which ones belong here. This account
	// has 50 and keeps 1.
	const buckets = items.filter((i) => i.cfnType === 'AWS::S3::Bucket');
	await inParallel(buckets, 8, async (bucket) => {
		const answer = await awsAsync('s3api', 'get-bucket-location', [
			'--bucket',
			String(bucket.importId)
		]);
		if (!answer) return;
		const home = answer.LocationConstraint || 'us-east-1';
		if (home !== region) bucket.dropForRegion = home;
	});
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].dropForRegion) items.splice(i, 1);
	}

	// The buckets that survived the filter are the ones worth reading, and this is
	// the earliest point at which that is known. Everything else was handed over
	// during the sweep; with this the read has seen every candidate there will be.
	handToDetail(items.filter((i) => DETAIL_AFTER_REGION.has(i.cfnType)));
	closeDetailInput();
}

// ------------------------- layer 1a-quater: which global resources belong here
//
// IAM, CloudFront and Route 53 have no region. A sweep of one region answers for
// the WHOLE ACCOUNT on those, and on a real account that is nearly the entire
// answer: measured in mx-central-1 on 2026-08-26, of 409 rows that could become
// nodes, 391 were global and 18 were actually in the region. The 18 included
// everything the person was looking for, and they were unfindable in the list.
//
// DROPPING THE GLOBALS IS WRONG. The role a function runs as has no region, and
// importing the function without it leaves the role unmanaged. So instead of
// guessing, each candidate is asked WHAT IT USES, and the globals it names are
// marked. A function answers `Role`; that role answers `Policies` and
// `ManagedPolicyArns`. The chain is the account's own answer, not a match on
// names -- which would be the same mistake the type mapping already refused.
//
// ONLY THE TYPES STRUCT8 ASKS FOR. One call per swept row would be thousands.
// `cfnDetailTypes` is the subset that can become a node at all, and only the
// catalog knows which those are, so it travels with the request like the sweep
// list does.
/**
 * How many candidates could not be read in detail, and why.
 *
 * Travels to the panel because the person choosing resources is the one who pays
 * for it: an unread candidate is a resource whose references were never followed,
 * so whatever it uses is offered as an anonymous row among hundreds.
 */
let detailUnread = null;

if (cfnDetailTypes.length) {
	// The reads have been running since the sweep started handing types over. This
	// is where they finish: the pool stops on its own once the input is closed and
	// its queue has drained.
	await detailPool;

	// NARROWING, the net under the per-call backoff. A read throttled hard enough
	// to exhaust its retries comes back here, and each round halves the width so
	// the last one is nearly serial. Whatever is still unread after this is counted
	// by reason and reported, never dropped.
	for (let width = 4; width >= 1 && throttledRows.length; width = Math.floor(width / 2)) {
		const again = throttledRows.splice(0, throttledRows.length);
		console.error(
			`scan-account: ${again.length} read(s) rate limited -- asking again, ${width} at a time.`
		);
		await inParallel(again, width, (r) =>
			readOne(r, width > 1 ? (x) => throttledRows.push(x) : null)
		);
	}

	detailUnread = unread
		? {
				count: unread,
				of: detailAsked,
				by: Object.fromEntries(unreadBy),
				who: unreadWho,
				named: Math.min(unread, UNREAD_NAMED)
			}
		: null;

	// Cloud Control identifies a role by its NAME and a distribution by its id,
	// while the reference that points at them is a full ARN. So a row is matched
	// on its identifier, on that identifier being the ARN's tail, or on the two
	// being equal outright -- whichever the type happens to use.
	const tail = (value) => String(value).split(/[/:]/).pop();
	const byIdentifier = new Map();
	for (const row of items) {
		if (!row.importId) continue;
		const id = String(row.importId);
		if (!byIdentifier.has(id)) byIdentifier.set(id, []);
		byIdentifier.get(id).push(row);
	}

	let marked = 0;
	for (const [arn, users] of namedBy) {
		const hits = byIdentifier.get(arn) ?? byIdentifier.get(tail(arn)) ?? [];
		for (const row of hits) {
			// Itself does not count: a resource whose own ARN appears in its own
			// configuration would otherwise look like something else needs it.
			const others = [...users].filter((u) => u !== String(row.importId));
			if (!others.length) continue;
			row.referencedBy = [...new Set([...(row.referencedBy ?? []), ...others])].sort();
			marked++;
		}
	}

	console.error(
		`scan-account: read ${detailAsked - unread} of ${detailAsked} candidate(s) in detail; ` +
			`${marked} resource(s) are used by one of them.`
	);
}

// ------------------------------------- layer 1b: the network family, by vpc-id
//
// `vpc-id` is a first-class filter on every EC2 listing, and unlike a tag it does
// not depend on anyone having tagged anything -- which in an account built by
// hand is the normal case. Without an anchor the whole region comes.
const vpcFilter = vpcIds.length ? ['--filters', `Name=vpc-id,Values=${vpcIds.join(',')}`] : [];

const vpcs = aws('ec2', 'describe-vpcs', vpcIds.length ? ['--vpc-ids', ...vpcIds] : []);
for (const vpc of vpcs?.Vpcs ?? []) {
	push(`arn:aws:ec2:${region}:${vpc.OwnerId}:vpc/${vpc.VpcId}`, {
		tags: tagsOf(vpc.Tags),
		// The VPC AWS hands out with the account. Nobody created it and nobody can
		// destroy it, so adopting it means owning something that cannot be undone.
		isDefault: vpc.IsDefault === true
	});
}

// `vpcId` on every network row: the selection screen groups by network, and the
// tagging API cannot answer which VPC a resource is in -- only these listings can.
for (const subnet of aws('ec2', 'describe-subnets', vpcFilter)?.Subnets ?? []) {
	push(`arn:aws:ec2:${region}:${subnet.OwnerId}:subnet/${subnet.SubnetId}`, {
		tags: tagsOf(subnet.Tags),
		vpcId: subnet.VpcId
	});
}

const igwFilter = vpcIds.length
	? ['--filters', `Name=attachment.vpc-id,Values=${vpcIds.join(',')}`]
	: [];
for (const igw of aws('ec2', 'describe-internet-gateways', igwFilter)?.InternetGateways ?? []) {
	push(`arn:aws:ec2:${region}:${igw.OwnerId}:internet-gateway/${igw.InternetGatewayId}`, {
		tags: tagsOf(igw.Tags),
		// The VPC it is attached to, which for this type lives in `Attachments`
		// rather than in a `VpcId` field of its own. Without it Struct8 cannot tell
		// that a gateway belongs to a VPC it is discarding -- and the default VPC's
		// gateway came through beside the one a person created, with nothing to say
		// which was which.
		vpcId: (igw.Attachments ?? []).find((a) => a.VpcId)?.VpcId ?? null
	});
}

const natFilter = vpcIds.length ? ['--filter', `Name=vpc-id,Values=${vpcIds.join(',')}`] : [];
for (const nat of aws('ec2', 'describe-nat-gateways', natFilter)?.NatGateways ?? []) {
	push(`arn:aws:ec2:${region}:${nat.OwnerId ?? ''}:natgateway/${nat.NatGatewayId}`, {
		tags: tagsOf(nat.Tags),
		vpcId: nat.VpcId
	});
	// The address the gateway holds. Struct8 drops it -- the compile writes it
	// back as `eip_<nat>` -- but it is reported so the drop is visible.
	for (const address of nat.NatGatewayAddresses ?? []) {
		if (!address.AllocationId) continue;
		push(`arn:aws:ec2:${region}:${nat.OwnerId ?? ''}:elastic-ip/${address.AllocationId}`, {
			ownedBy: nat.NatGatewayId
		});
	}
}

// ---------------------------- layer 2: children expanded from a parent's answer
//
// These have no listing API of their own, and most have no ARN at all. What they
// do have is a composite id Terraform imports them by, and every part of it is
// already in the parent's response -- so they cost zero extra calls.

for (const table of aws('ec2', 'describe-route-tables', vpcFilter)?.RouteTables ?? []) {
	push(`arn:aws:ec2:${region}:${table.OwnerId}:route-table/${table.RouteTableId}`, {
		tags: tagsOf(table.Tags),
		vpcId: table.VpcId,
		// The main route table, which AWS creates with the VPC. There is no
		// `IsDefault` on this type -- the only sign is that one of its
		// associations is the main one. Without this it arrives untagged and
		// unmarked, and gets adopted as if a person had made it. Seen on a real
		// account: `rtb-0ab086790b184a34b`, named after its own id because there
		// was no tag to name it from.
		isDefault: (table.Associations ?? []).some((a) => a.Main === true)
	});
	for (const association of table.Associations ?? []) {
		// The main association belongs to the VPC, not to a subnet, and Terraform
		// imports it as a different resource. Left out rather than mis-shaped.
		if (!association.SubnetId) continue;
		items.push({
			arn: '',
			terraformTypeHint: 'aws_route_table_association',
			importId: `${association.SubnetId}/${table.RouteTableId}`,
			nameHint: `${association.SubnetId}_${table.RouteTableId}`,
			vpcId: table.VpcId
		});
	}
}

for (const acl of aws('ec2', 'describe-network-acls', vpcFilter)?.NetworkAcls ?? []) {
	push(`arn:aws:ec2:${region}:${acl.OwnerId}:network-acl/${acl.NetworkAclId}`, {
		tags: tagsOf(acl.Tags),
		isDefault: acl.IsDefault === true,
		vpcId: acl.VpcId
	});
	// The default ACL is dropped by Struct8 as something AWS created, so its
	// rules have nothing to attach to. Not expanding them here is cheaper than
	// sending them to be discarded, and Struct8 discards them anyway -- both
	// sides check, because either one alone leaves the rules adoptable if the
	// other changes.
	if (acl.IsDefault === true) continue;

	for (const entry of acl.Entries ?? []) {
		// 32767 is the catch-all rule AWS puts in every ACL. It is not importable
		// and Terraform does not manage it.
		if (entry.RuleNumber === 32767) continue;
		items.push({
			arn: '',
			terraformTypeHint: 'aws_network_acl_rule',
			// The order Terraform documents for this type:
			// <acl-id>:<rule-number>:<protocol>:<egress>
			importId: `${acl.NetworkAclId}:${entry.RuleNumber}:${entry.Protocol}:${entry.Egress}`,
			nameHint: `${entry.Egress ? 'out' : 'in'}_${acl.NetworkAclId}_${entry.RuleNumber}`,
			vpcId: acl.VpcId
		});
	}
}

for (const group of aws('ec2', 'describe-security-groups', vpcFilter)?.SecurityGroups ?? []) {
	push(`arn:aws:ec2:${region}:${group.OwnerId}:security-group/${group.GroupId}`, {
		tags: tagsOf(group.Tags),
		// Every VPC gets one, and it is not something a person created.
		isDefault: group.GroupName === 'default',
		vpcId: group.VpcId
	});
}

// ------------------------------- layer 2, off the VPC: the targets of a rule
//
// An EventBridge target is what connects a rule to the Lambda, queue or topic it
// invokes, and AWS publishes no object for it: it is a row inside the rule,
// reachable only through `list-targets-by-rule`. The sweep cannot find it --
// there is no ARN to list -- so without this block the rule arrives on the
// diagram with nothing attached to it, which is how it looked after the scan of
// mx-central-1 on 2026-08-28: correct in the account, alone on the canvas.
//
// THE ID CARRIES THE BUS EXACTLY WHEN THE ARN DOES. A rule's own ARN is
// `rule/<name>` on the default bus and `rule/<bus>/<name>` on any other, and the
// provider splits a target's id the same way -- two segments mean the default
// bus, three name one. Composing it by the same rule keeps this answer identical
// to the one Struct8 composes from the configuration when it adopts (see
// `COMPOSERS` in core/configImports.ts), so the two paths never disagree about
// the same target.
//
// ASKED ONLY WHEN THE RULE ITSELF WAS ASKED FOR. The target follows its parent's
// scope: with `AWS::Events::Rule` absent from the sweep no rule reaches the
// diagram, so a target would name a rule that is not there -- and the calls
// below would be spent to produce it.
if (cfnTypes.includes('AWS::Events::Rule')) {
	for (const bus of aws('events', 'list-event-buses')?.EventBuses ?? []) {
		if (!bus.Name) continue;
		const rules = aws('events', 'list-rules', ['--event-bus-name', bus.Name])?.Rules ?? [];
		for (const rule of rules) {
			if (!rule.Name) continue;
			const scopedRule = bus.Name === 'default' ? rule.Name : `${bus.Name}/${rule.Name}`;
			const targets =
				aws('events', 'list-targets-by-rule', [
					'--rule',
					rule.Name,
					'--event-bus-name',
					bus.Name
				])?.Targets ?? [];
			for (const target of targets) {
				// The id is what Terraform imports by, and AWS composes one when the
				// caller does not supply it. A target without one cannot be named, so
				// it is left out rather than given an id that points at nothing.
				if (!target.Id) continue;
				items.push({
					arn: '',
					terraformTypeHint: 'aws_cloudwatch_event_target',
					importId: `${scopedRule}/${target.Id}`,
					nameHint: `${rule.Name}_${target.Id}`
				});
			}
		}
	}
}

const caller = aws('sts', 'get-caller-identity');

fs.writeFileSync(
	outPath,
	JSON.stringify(
		{
			version: 1,
			requestId,
			region,
			accountId: caller?.Account ?? null,
			// No timestamp from this side on purpose: the commit already carries one,
			// and a second clock is a second thing that can disagree.
			// The type list is echoed as a count, not in full: it is hundreds of
			// entries, Struct8 already has it, and the number is what tells someone
			// reading this file whether the sweep was as wide as they meant.
			scope: { vpcIds, tagFilters, cfnTypeCount: cfnTypes.length, cfnDetailTypeCount: cfnDetailTypes.length },
			items,
			detailUnread,
			errors
		},
		null,
		1
	)
);

console.error(`scan-account: ${items.length} item(s), ${errors.length} error(s) in ${region}`);
console.error(`scan-account: wrote ${outPath}`);
