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
// PASSO 2, with `AWS_PROFILE=target` exported, so the AWS CLI reaches the
// account being scanned and this script needs no credential handling of its own.
//
// SCOPE. Read from `scan_scope.json` in the working directory, which Struct8
// pushes next to the manifest. Command-line flags override it, which is what
// makes the script runnable by hand while debugging.
//
// Usage:
//   node scan-account.mjs [--region us-east-1] [--out scan_inventory.json]
//                         [--vpc vpc-0703...] [--tag Project=k8hub]
//                         [--type AWS::Lambda::Function ...]

import { execFileSync, execFile } from 'node:child_process';
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
 * The same call, off the main thread, so many can be in flight at once.
 *
 * Only the type sweep uses it. Everything else here is a handful of calls where
 * the synchronous version reads better and costs nothing.
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
 * A fixed pool rather than `Promise.all` over everything: 478 AWS CLI processes
 * at once is 478 processes, and the rate limiter would refuse most of them
 * anyway.
 */
async function inParallel(list, width, worker) {
	const queue = [...list];
	const runners = Array.from({ length: Math.min(width, queue.length) }, async () => {
		while (queue.length) await worker(queue.shift());
	});
	await Promise.all(runners);
}

const items = [];
const push = (arn, extra = {}) => items.push({ arn, ...extra });
const tagsOf = (list) =>
	Object.fromEntries((list ?? []).map((t) => [t.Key ?? t.key, t.Value ?? t.value]));

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

	// CONCURRENT, and it is not an optimisation. Measured on 2026-08-25: 478 types
	// asked one after another did not finish inside ten minutes, and the panel
	// waiting on this run gives up at twenty. Each call is almost entirely time
	// spent waiting on AWS, so width costs nothing locally and is the difference
	// between a scan someone waits through and one they abandon.
	//
	// Rate limiting is the expected cost of that width, not a failure, and it is
	// why throttled types come back for a second, narrower pass rather than being
	// reported as missing. A type that is still throttled after that IS reported --
	// silently returning fewer resources than the account holds is the one outcome
	// worth failing over, because half a diagram looks exactly like a whole one.
	const throttled = [];
	const isThrottle = (message) => /Throttl|Rate exceeded|TooManyRequests/i.test(message);

	async function sweep(type, onThrottle) {
		let token = null;
		do {
			const page = await awsAsync(
				'cloudcontrol',
				'list-resources',
				token ? ['--type-name', type, '--next-token', token] : ['--type-name', type],
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
				if (row.Identifier) push(null, { cfnType: type, importId: row.Identifier });
			}
			token = page.NextToken || null;
		} while (token);
	}

	await inParallel(cfnTypes, 10, (type) => sweep(type, (t) => throttled.push(t)));

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

// ------------------------------ layer 1a-ter: which global resources belong here
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
if (cfnDetailTypes.length) {
	const wanted = new Set(cfnDetailTypes);
	const candidates = items.filter((i) => i.cfnType && wanted.has(i.cfnType));

	/** Every ARN a candidate's own configuration names, and who named it. */
	const namedBy = new Map();
	let unread = 0;

	await inParallel(candidates, 8, async (row) => {
		const answer = await awsAsync(
			'cloudcontrol',
			'get-resource',
			['--type-name', row.cfnType, '--identifier', String(row.importId)],
			() => {
				// A resource that cannot be read individually costs its references and
				// nothing else -- the row itself already came from the listing and stays.
				unread++;
				return true;
			}
		);
		// Properties arrive as a JSON STRING inside the answer, not as an object.
		const properties = answer?.ResourceDescription?.Properties;
		if (typeof properties !== 'string') return;
		for (const arn of properties.match(/arn:aws[a-z-]*:[^"\\\s,\]]+/g) ?? []) {
			if (!namedBy.has(arn)) namedBy.set(arn, new Set());
			namedBy.get(arn).add(String(row.importId));
		}
	});

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
		`scan-account: read ${candidates.length - unread} of ${candidates.length} candidate(s) in detail; ` +
			`${marked} resource(s) are used by one of them.`
	);
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
	const buckets = items.filter((i) => i.cfnType === 'AWS::S3::Bucket');
	for (const bucket of buckets) {
		const answer = aws('s3api', 'get-bucket-location', ['--bucket', String(bucket.importId)]);
		if (!answer) continue;
		const home = answer.LocationConstraint || 'us-east-1';
		if (home !== region) bucket.dropForRegion = home;
	}
	for (let i = items.length - 1; i >= 0; i--) {
		if (items[i].dropForRegion) items.splice(i, 1);
	}
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

const caller = aws('sts', 'get-caller-identity');

fs.writeFileSync(
	outPath,
	JSON.stringify(
		{
			version: 1,
			region,
			accountId: caller?.Account ?? null,
			// No timestamp from this side on purpose: the commit already carries one,
			// and a second clock is a second thing that can disagree.
			// The type list is echoed as a count, not in full: it is hundreds of
			// entries, Struct8 already has it, and the number is what tells someone
			// reading this file whether the sweep was as wide as they meant.
			scope: { vpcIds, tagFilters, cfnTypeCount: cfnTypes.length, cfnDetailTypeCount: cfnDetailTypes.length },
			items,
			errors
		},
		null,
		1
	)
);

console.error(`scan-account: ${items.length} item(s), ${errors.length} error(s) in ${region}`);
console.error(`scan-account: wrote ${outPath}`);
