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
//   1. Resources with a listing API. The tagging API answers every taggable
//      resource in the region in one paginated call, across services. The
//      network family is asked separately, by `vpc-id`, because a subnet that
//      nobody tagged still has to come.
//
//   2. Children that live INSIDE a parent's answer. An ACL entry has no listing
//      API and no ARN -- it is a row in `describe-network-acls`. Those cost no
//      extra call: they are expanded out of the parent's response, and each
//      carries the composite id Terraform imports it by.
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

import { execFileSync } from 'node:child_process';
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

if (!region) {
	console.error('scan-account: no region -- not in scan_scope.json, --region or AWS_REGION.');
	process.exit(2);
}

const errors = [];

/** One AWS CLI call. A failure is recorded and the scan continues. */
function aws(service, operation, extra = []) {
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
		errors.push({
			source: `${service} ${operation}`,
			message: String(error?.stderr ?? error?.message ?? error).slice(0, 400)
		});
		return null;
	}
}

const items = [];
const push = (arn, extra = {}) => items.push({ arn, ...extra });
const tagsOf = (list) =>
	Object.fromEntries((list ?? []).map((t) => [t.Key ?? t.key, t.Value ?? t.value]));

// --------------------------------------------- layer 1a: everything taggable
//
// One call for the whole region, across every service. It is an INDEX, not the
// services themselves -- it keeps entries for resources that were destroyed, so
// a name that was created and deleted repeatedly accumulates dead ARNs. The read
// pass is what settles it: an id that no longer resolves fails its import block
// and is reported, which is the only test that separates the live one.
{
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
			scope: { vpcIds, tagFilters },
			items,
			errors
		},
		null,
		1
	)
);

console.error(`scan-account: ${items.length} item(s), ${errors.length} error(s) in ${region}`);
console.error(`scan-account: wrote ${outPath}`);
