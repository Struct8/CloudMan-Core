// Exercises scan-account.mjs without an AWS account.
//
// HOW, and why this shape. The script is a program, not a module -- it has no
// exports to call. So the test takes its source, swaps the one line that reaches
// the outside world (`execFileSync`) for a table of canned answers, and runs the
// result. Everything else executes exactly as written: the pagination loop, the
// vpc filters, the layer-2 expansion, the error path, the output shape.
//
// WHAT IT DOES NOT COVER. That the real AWS CLI is invoked with valid flags, and
// that its real answers have these field names. Only a run against an account
// settles that. What this settles is the part that is ours.
//
// No dependencies and no runner on purpose: this repository is bash plus one
// .mjs, and adding a test framework to it would be a bigger change than the
// thing being tested.
//
// Usage:
//   node scripts/scan-account.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SOURCE = path.join(HERE, 'scan-account.mjs');

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${detail}`);
		failures++;
	}
}

const A = '262578989263';
const R = 'us-east-1';

/**
 * What the fake CLI answers, keyed by `<service> <operation>`.
 *
 * `THROWS` marks a call that fails, which is how the error path is reached: one
 * service the credentials cannot read must not cost the scan.
 */
const ANSWERS = {
	'resourcegroupstaggingapi get-resources': [
		{
			ResourceTagMappingList: [
				{ ResourceARN: `arn:aws:eks:${R}:${A}:cluster/eks-k8hub`, Tags: [{ Key: 'Name', Value: 'eks-k8hub' }] },
				{ ResourceARN: 'arn:aws:s3:::s3-loki-billing-pay', Tags: [] }
			],
			PaginationToken: 'page2'
		},
		{
			ResourceTagMappingList: [
				{ ResourceARN: `arn:aws:lambda:${R}:${A}:function:cost-report`, Tags: [] }
			],
			PaginationToken: ''
		}
	],
	'ec2 describe-vpcs': [
		{
			Vpcs: [
				{ VpcId: 'vpc-0703', OwnerId: A, IsDefault: false, Tags: [{ Key: 'Name', Value: 'EKS-k8hub' }] }
			]
		}
	],
	'ec2 describe-subnets': [
		{ Subnets: [{ SubnetId: 'subnet-a', OwnerId: A, VpcId: 'vpc-0703', Tags: [{ Key: 'Name', Value: 'public-a' }] }] }
	],
	'ec2 describe-internet-gateways': [{ InternetGateways: [{ InternetGatewayId: 'igw-01', OwnerId: A, Tags: [] }] }],
	'ec2 describe-nat-gateways': [
		{
			NatGateways: [
				{
					NatGatewayId: 'nat-0bce',
					OwnerId: A,
					VpcId: 'vpc-0703',
					Tags: [],
					NatGatewayAddresses: [{ AllocationId: 'eipalloc-0ded' }]
				}
			]
		}
	],
	'ec2 describe-route-tables': [
		{
			RouteTables: [
				{
					RouteTableId: 'rtb-08ae',
					OwnerId: A,
					VpcId: 'vpc-0703',
					Tags: [],
					Associations: [
						{ SubnetId: 'subnet-a' },
						// The main association: belongs to the VPC, not a subnet.
						{ Main: true }
					]
				}
			]
		}
	],
	'ec2 describe-network-acls': [
		{
			NetworkAcls: [
				{
					NetworkAclId: 'acl-0e6e4c',
					OwnerId: A,
					VpcId: 'vpc-0703',
					IsDefault: false,
					Tags: [],
					Entries: [
						{ RuleNumber: 100, Protocol: '6', Egress: false },
						// AWS's catch-all, in every ACL and not importable.
						{ RuleNumber: 32767, Protocol: '-1', Egress: false }
					]
				}
			]
		}
	],
	// The one the credentials cannot read.
	'ec2 describe-security-groups': 'THROWS',
	'sts get-caller-identity': [{ Account: A }]
};

// Build a runnable copy whose only outside call is the table above. The marker
// is the import line, which is why it is matched exactly rather than by regex
// over the whole file: if it ever changes, this fails loudly instead of
// silently testing nothing.
const original = fs.readFileSync(SOURCE, 'utf-8');
const IMPORT_LINE = "import { execFileSync } from 'node:child_process';";
if (!original.includes(IMPORT_LINE)) {
	console.log(`FAIL - scan-account.mjs no longer imports execFileSync the way this test stubs it`);
	process.exit(1);
}

const stub = `
const __ANSWERS = ${JSON.stringify(ANSWERS)};
const __CALLS = [];
const __PAGE = {};
function execFileSync(_bin, argv) {
	const key = argv[0] + ' ' + argv[1];
	__CALLS.push(argv.join(' '));
	const answer = __ANSWERS[key];
	if (answer === undefined) throw new Error('unexpected call: ' + key);
	if (answer === 'THROWS') { const e = new Error('AccessDenied'); e.stderr = 'AccessDenied'; throw e; }
	const i = __PAGE[key] ?? 0;
	__PAGE[key] = i + 1;
	return JSON.stringify(answer[Math.min(i, answer.length - 1)]);
}
process.on('exit', () => { try { fs.writeFileSync('calls.json', JSON.stringify(__CALLS, null, 1)); } catch {} });
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct8-scan-'));
try {
	fs.writeFileSync(path.join(dir, 'scan-account.mjs'), original.replace(IMPORT_LINE, stub));
	fs.writeFileSync(
		path.join(dir, 'scan_scope.json'),
		JSON.stringify({ region: R, vpcIds: ['vpc-0703'], tagFilters: [] })
	);

	execFileSync('node', ['scan-account.mjs'], { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });

	const out = JSON.parse(fs.readFileSync(path.join(dir, 'scan_inventory.json'), 'utf-8'));
	const arns = out.items.map((i) => i.arn).filter(Boolean);
	const hints = out.items.filter((i) => !i.arn);

	check('the account id came from the caller identity', out.accountId === A, out.accountId);
	check('the scope was read from scan_scope.json', out.scope.vpcIds[0] === 'vpc-0703');

	// -------------------------------------------------------------- layer 1a
	check(
		'the tagging API was paginated to the end, so page 2 is in',
		arns.includes(`arn:aws:lambda:${R}:${A}:function:cost-report`),
		JSON.stringify(arns)
	);
	check('a bucket with no tags still came', arns.includes('arn:aws:s3:::s3-loki-billing-pay'));

	// -------------------------------------------------------------- layer 1b
	check('the VPC came, named by its tag', out.items.some((i) => i.tags?.Name === 'EKS-k8hub'));
	check(
		'the subnet carries its vpcId, which the tagging API cannot answer',
		out.items.find((i) => i.arn.endsWith('subnet/subnet-a'))?.vpcId === 'vpc-0703'
	);
	check(
		"the NAT's address came marked as owned, so Struct8 can drop it knowingly",
		out.items.find((i) => i.arn.endsWith('elastic-ip/eipalloc-0ded'))?.ownedBy === 'nat-0bce'
	);

	// --------------------------------------------------------------- layer 2
	const association = hints.find((i) => i.terraformTypeHint === 'aws_route_table_association');
	check('the subnet association was expanded out of the route table', !!association);
	check(
		'and it carries the composite id Terraform imports it by',
		association?.importId === 'subnet-a/rtb-08ae',
		association?.importId
	);
	check(
		'the main association was left out, because Terraform imports it as another type',
		hints.filter((i) => i.terraformTypeHint === 'aws_route_table_association').length === 1
	);

	const entry = hints.find((i) => i.terraformTypeHint === 'aws_network_acl_rule');
	check(
		'the ACL entry was expanded, with acl:rule:protocol:egress in that order',
		entry?.importId === 'acl-0e6e4c:100:6:false',
		entry?.importId
	);
	check(
		"AWS's catch-all rule 32767 was left out",
		hints.filter((i) => i.terraformTypeHint === 'aws_network_acl_rule').length === 1
	);

	// ----------------------------------------------------------- the failure
	check(
		'the service that refused is reported, not swallowed',
		out.errors.length === 1 && out.errors[0].source === 'ec2 describe-security-groups',
		JSON.stringify(out.errors)
	);
	check(
		'and the scan still produced everything else',
		out.items.length >= 8,
		`${out.items.length} item(s)`
	);

	// ------------------------------------------------- the flags actually sent
	const calls = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf-8'));
	check(
		'the vpc filter reached the subnet listing',
		calls.some((c) => c.startsWith('ec2 describe-subnets') && c.includes('Name=vpc-id,Values=vpc-0703')),
		JSON.stringify(calls.filter((c) => c.startsWith('ec2 describe-subnets')))
	);
	check(
		'the internet gateway uses attachment.vpc-id, which is its own filter name',
		calls.some((c) => c.startsWith('ec2 describe-internet-gateways') && c.includes('attachment.vpc-id'))
	);
	check(
		'the NAT gateway uses --filter, singular, which is what that API takes',
		calls.some((c) => c.startsWith('ec2 describe-nat-gateways') && c.includes('--filter Name=vpc-id'))
	);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
