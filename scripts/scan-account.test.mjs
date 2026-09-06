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
	// ---------------------------------------------------- layer 1a, the sweep
	//
	// One entry per type, because the stub keys on `--type-name` -- otherwise
	// every type in the loop would eat the next canned page and the pagination
	// case would be testing the wrong thing.
	//
	// NOTHING HERE CARRIES A TAG. That is the point of the change being tested:
	// these are what an account built in the console looks like, and the tagging
	// index this replaced could not see any of them.
	'cloudcontrol list-resources AWS::Lambda::Function': [
		{
			ResourceDescriptions: [{ Identifier: 'cost-report', Properties: '{}' }],
			NextToken: 'page2'
		},
		{
			ResourceDescriptions: [{ Identifier: 'import-lab-processor', Properties: '{}' }],
			NextToken: ''
		}
	],
	// Two roles. IAM has no region, so both come back from a sweep of ANY region --
	// and only one of them has anything to do with what is being imported.
	'cloudcontrol list-resources AWS::IAM::Role': [
		{
			ResourceDescriptions: [
				{ Identifier: 'cost-report-role', Properties: '{}' },
				{ Identifier: 'nada-a-ver-role', Properties: '{}' }
			]
		}
	],
	// One candidate read in detail: this is where the function names the role it uses.
	//
	// RATE LIMITED THE FIRST TIME, on purpose. This read is the one that carries the
	// reference, so without a retry the role below goes unmarked -- which is exactly
	// what happened on a real account on 2026-08-26. The assertion that the role is
	// marked is therefore also the assertion that the retry happened.
	'cloudcontrol get-resource AWS::Lambda::Function cost-report': [
		{ THROWS: 'ThrottlingException: Rate exceeded' },
		{
			ResourceDescription: {
				Identifier: 'cost-report',
				Properties: '{"FunctionName":"cost-report","Role":"arn:aws:iam::262578989263:role/cost-report-role"}'
			}
		}
	],
	'cloudcontrol get-resource AWS::Lambda::Function import-lab-processor': [
		{
			ResourceDescription: {
				Identifier: 'import-lab-processor',
				Properties: '{"FunctionName":"import-lab-processor"}'
			}
		}
	],
	// Refused outright, every time: what the count has to report. The row itself
	// still came from the listing and stays -- an unread candidate costs its
	// references, not its own existence.
	'cloudcontrol get-resource AWS::DynamoDB::Table import-lab-items': 'THROWS',
	'cloudcontrol list-resources AWS::DynamoDB::Table': [
		{ ResourceDescriptions: [{ Identifier: 'import-lab-items', Properties: '{}' }] }
	],
	// Two buckets: one in the region being scanned, one somewhere else. S3 answers
	// the whole account whatever region is asked, which is why the script has to
	// ask each bucket where it lives.
	'cloudcontrol list-resources AWS::S3::Bucket': [
		{
			ResourceDescriptions: [
				{ Identifier: 'bucket-aqui', Properties: '{"BucketName":"bucket-aqui"}' },
				{ Identifier: 'bucket-noutra-regiao', Properties: '{"BucketName":"bucket-noutra-regiao"}' }
			]
		}
	],
	// null LocationConstraint means us-east-1. Reading it as "no region" is what
	// would silently drop every bucket in the busiest region AWS has.
	'cloudcontrol get-resource AWS::S3::Bucket bucket-aqui': [
		{ ResourceDescription: { Identifier: 'bucket-aqui', Properties: '{"BucketName":"bucket-aqui"}' } }
	],
	// Answered so a regression does not crash the stub -- the assertion is that this
	// is never asked for, not that asking it fails.
	'cloudcontrol get-resource AWS::S3::Bucket bucket-noutra-regiao': [
		{ ResourceDescription: { Identifier: 'bucket-noutra-regiao', Properties: '{}' } }
	],
	// A type AWS fills with its own catalogue. Asked of IAM, which can filter by
	// owner, instead of Cloud Control, which cannot: in a real account this is 93
	// rows in one call rather than 1667 over seventeen pages, and the 1574 left
	// behind are AWS's own policies that get discarded further along anyway.
	'iam list-policies': [
		{
			Policies: [
				{ Arn: 'arn:aws:iam::262578989263:policy/deploy-can-write', PolicyName: 'deploy-can-write' }
			]
		}
	],
	// Answered so a regression does not crash the stub. The assertion is that the
	// sweep never asks this, because IAM already answered it.
	'cloudcontrol list-resources AWS::IAM::ManagedPolicy': [
		{
			ResourceDescriptions: [
				{ Identifier: 'arn:aws:iam::262578989263:policy/deploy-can-write', Properties: '{}' },
				{ Identifier: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess', Properties: '{}' }
			]
		}
	],
	's3api get-bucket-location bucket-aqui': [{ LocationConstraint: null }],
	's3api get-bucket-location bucket-noutra-regiao': [{ LocationConstraint: 'sa-east-1' }],
	// A type with no LIST handler at all. Normal across a sweep this wide, and a
	// property of the type rather than of this account -- so it must NOT be
	// reported as an error.
	'cloudcontrol list-resources AWS::IAM::Policy': {
		THROWS: 'UnsupportedActionException: Resource type AWS::IAM::Policy does not support LIST action'
	},
	// Refuses without a parent id. Also expected, also not this account's fault.
	'cloudcontrol list-resources AWS::ApiGateway::Resource': {
		THROWS:
			'InvalidRequestException: Missing or invalid ResourceModel property. Required property: (#: required key [RestApiId] not found)'
	},
	// A genuine failure, which MUST still be reported: the difference between
	// "this type never lists" and "your credentials could not read it" is the
	// whole reason the sweep classifies instead of swallowing.
	'cloudcontrol list-resources AWS::Batch::JobQueue': {
		THROWS: 'AccessDeniedException: not authorized to perform cloudformation:ListResources'
	},
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

	// ------------------------------ layer 2, off the VPC: EventBridge targets
	//
	// Two buses, because the id carries the bus only when the bus is not the
	// default one and one bus alone cannot show that. The rules themselves come
	// from the sweep above; what is expanded here is only what lives inside them.
	'cloudcontrol list-resources AWS::Events::Rule': [
		{ ResourceDescriptions: [{ Identifier: 'import-lab3-daily', Properties: '{}' }] }
	],
	'events list-event-buses': [
		{ EventBuses: [{ Name: 'default' }, { Name: 'barramento-de-pedidos' }] }
	],
	'events list-rules default': [{ Rules: [{ Name: 'import-lab3-daily' }] }],
	'events list-rules barramento-de-pedidos': [{ Rules: [{ Name: 'pedido-criado' }] }],
	'events list-targets-by-rule default import-lab3-daily': [
		{
			Targets: [
				{ Id: 'ingest-lambda', Arn: `arn:aws:lambda:${R}:${A}:function:import-lab3-ingest` },
				// No `Id`: nothing can name it, so it must be left out rather than
				// given an id that points at nothing.
				{ Arn: `arn:aws:sqs:${R}:${A}:orders` }
			]
		}
	],
	'events list-targets-by-rule barramento-de-pedidos pedido-criado': [
		{ Targets: [{ Id: 'notifica', Arn: `arn:aws:sns:${R}:${A}:pedidos` }] }
	],

	'sts get-caller-identity': [{ Account: A }]
};

// Build a runnable copy whose only outside call is the table above. The marker
// is the import line, which is why it is matched exactly rather than by regex
// over the whole file: if it ever changes, this fails loudly instead of
// silently testing nothing.
const original = fs.readFileSync(SOURCE, 'utf-8');
// TWO markers now, because the script reaches outside in two ways: the AWS CLI
// for the handful of `ec2`/`s3api` calls, and the in-process Cloud Control client
// for the several hundred that used to be child processes. Both are matched
// exactly rather than by regex, so that a change to either fails loudly here
// instead of silently testing nothing -- or, worse, reaching a real account.
const IMPORT_LINE = "import { execFileSync, execFile } from 'node:child_process';";
const CLOUD_CONTROL_LINE =
	"import { cloudControl, resolveCredentials } from './lib/cloud-control.mjs';";
for (const [what, line] of [
	['the AWS CLI', IMPORT_LINE],
	['the Cloud Control client', CLOUD_CONTROL_LINE]
]) {
	if (!original.includes(line)) {
		console.log(`FAIL - scan-account.mjs no longer imports ${what} the way this test stubs it`);
		process.exit(1);
	}
}

const stub = `
const __ANSWERS = ${JSON.stringify(ANSWERS)};
const __CALLS = [];
const __PAGE = {};
// The sweep asks the same operation once per type, and S3's location once per
// bucket, so those two need the argument in the key -- without it every call
// after the first would be answered for the wrong resource.
function __keyOf(argv) {
	const base = argv[0] + ' ' + argv[1];
	const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
	const type = at('--type-name');
	const ident = at('--identifier') ?? at('--bucket');
	// The rule and the bus for the same reason: EventBridge is asked once per bus
	// and once per rule, and a key that ignored them would answer the second rule
	// with the first one's targets.
	const bus = at('--event-bus-name');
	const rule = at('--rule');
	return base + (type ? ' ' + type : '') + (ident ? ' ' + ident : '') +
		(bus ? ' ' + bus : '') + (rule ? ' ' + rule : '');
}
function execFileSync(_bin, argv) {
	const key = __keyOf(argv);
	__CALLS.push(argv.join(' '));
	const answer = __ANSWERS[key];
	if (answer === undefined) throw new Error('unexpected call: ' + key);
	if (answer === 'THROWS') { const e = new Error('AccessDenied'); e.stderr = 'AccessDenied'; throw e; }
	if (answer && answer.THROWS) { const e = new Error(answer.THROWS); e.stderr = answer.THROWS; throw e; }
	const i = __PAGE[key] ?? 0;
	__PAGE[key] = i + 1;
	const page = answer[Math.min(i, answer.length - 1)];
	// Per-page, so an answer can refuse the first time and work the second -- which
	// is the only way to tell a retry that happened from one that did not.
	if (page && page.THROWS) { const e = new Error(page.THROWS); e.stderr = page.THROWS; throw e; }
	return JSON.stringify(page);
}
// Cloud Control, answered from the SAME table and under the same keys the CLI
// used. The keys are still written \`cloudcontrol list-resources <Type>\` on
// purpose: what changed is how the question travels, not which question is asked,
// and keeping the table identical is what makes that claim testable.
function resolveCredentials() {
	return { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake', sessionToken: null };
}
// The bucket location loop asks S3 once per bucket and does it concurrently, so
// it takes the callback form. Same table, same keys -- only the shape of the
// answer differs, which keeps the concurrent path and the sequential one honest
// about testing the same thing.
function execFile(bin, argv, _opts, cb) {
	try { cb(null, execFileSync(bin, argv), ''); }
	catch (e) { cb(e, '', e.stderr ?? e.message); }
}
// One type answers SLOWLY, and that is what makes the overlap observable. With
// every answer instant, all seven types finish inside one batch of microtasks and
// the reads -- which are woken by a listing finishing -- never get a turn before
// the last one. That would leave the ordering assertion below passing or failing
// on the event loop rather than on the design.
const __SLOW = { 'AWS::IAM::Role': 40 };
function cloudControl(operation, payload) {
	const argv =
		operation === 'ListResources'
			? ['cloudcontrol', 'list-resources', '--type-name', payload.TypeName]
			: ['cloudcontrol', 'get-resource', '--type-name', payload.TypeName, '--identifier', payload.Identifier];
	const answer = () => {
		try {
			return { ok: true, value: JSON.parse(execFileSync('aws', argv)) };
		} catch (e) {
			// The real client turns a refusal into \`{ok:false, message}\` carrying the
			// CLI's own \`<Exception>: <text>\` wording, which is what the caller's
			// regexes read. The stub has to hand back the same shape or every failure
			// would be classified as a success with no answer.
			return { ok: false, message: String(e.stderr ?? e.message) };
		}
	};
	const wait = operation === 'ListResources' ? (__SLOW[payload.TypeName] ?? 0) : 0;
	// The call is recorded when it is answered, so a slow listing lands late in
	// \`calls.json\` -- which is the order the assertion reads.
	return wait ? new Promise((r) => setTimeout(() => r(answer()), wait)) : Promise.resolve(answer());
}
process.on('exit', () => { try { fs.writeFileSync('calls.json', JSON.stringify(__CALLS, null, 1)); } catch {} });
`;

/**
 * The script with both outside calls swapped for the table.
 *
 * The Cloud Control import is deleted rather than rewritten: the copy runs from a
 * temp directory, so a relative import would not resolve there even if the stub
 * did not already define both names.
 */
const patched = (body) => original.replace(IMPORT_LINE, body).replace(CLOUD_CONTROL_LINE, '');

let callsFromMainRun = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct8-scan-'));
try {
	fs.writeFileSync(path.join(dir, 'scan-account.mjs'), patched(stub));
	fs.writeFileSync(
		path.join(dir, 'scan_scope.json'),
		JSON.stringify({
			region: R,
			vpcIds: ['vpc-0703'],
			tagFilters: [],
			// Six types: three that answer, two that refuse for reasons that are
			// normal, one that refuses for a reason that is not. `AWS::Events::Rule`
			// is the seventh, and it is here for a different job: it is what opens
			// the target expansion below, which is asked only when the rule itself
			// was asked for.
			cfnTypes: [
				'AWS::Lambda::Function',
				'AWS::DynamoDB::Table',
				'AWS::S3::Bucket',
				'AWS::IAM::Role',
				'AWS::IAM::Policy',
				'AWS::ApiGateway::Resource',
				'AWS::Events::Rule',
				'AWS::Batch::JobQueue',
				// Swept like any other type as far as Struct8 is concerned. What the
				// scanner does with it is the subject of the assertions below.
				'AWS::IAM::ManagedPolicy'
			],
			// IAM is deliberately NOT here: it is the global type whose members we want
			// to discover BY REFERENCE, not a candidate to ask what it uses.
			cfnDetailTypes: ['AWS::Lambda::Function', 'AWS::DynamoDB::Table', 'AWS::S3::Bucket'],
			requestId: 'pedido-42'
		})
	);

	execFileSync('node', ['scan-account.mjs'], { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });

	const out = JSON.parse(fs.readFileSync(path.join(dir, 'scan_inventory.json'), 'utf-8'));
	const arns = out.items.map((i) => i.arn).filter(Boolean);
	const hints = out.items.filter((i) => !i.arn);

	check('the account id came from the caller identity', out.accountId === A, out.accountId);
	check('the scope was read from scan_scope.json', out.scope.vpcIds[0] === 'vpc-0703');
	// The answer says which request it answers. Without it, the file the PREVIOUS
	// scan left at this same path is complete, valid, and indistinguishable from
	// the one being waited for -- which is how a scan still running came to show a
	// finished list on 2026-08-26.
	check('the answer carries the id of the request that asked for it',
		out.requestId === 'pedido-42', String(out.requestId));

	// -------------------------------------------------------------- layer 1a
	const swept = out.items.filter((i) => i.cfnType);
	const byId = (id) => swept.find((i) => i.importId === id);

	// The case the whole change exists for: an untagged resource is found. Under
	// the tagging index this was invisible, and no amount of paging reached it.
	check('an untagged function was found', !!byId('import-lab-processor'), JSON.stringify(swept));
	check('an untagged table was found', !!byId('import-lab-items'));
	check(
		'the sweep paginated to the end, so page 2 is in',
		!!byId('cost-report'),
		JSON.stringify(swept.map((i) => i.importId))
	);
	check(
		'each row says which AWS type answered it',
		byId('import-lab-processor')?.cfnType === 'AWS::Lambda::Function',
		byId('import-lab-processor')?.cfnType
	);
	// Cloud Control answers an identifier, not an ARN, and that identifier is
	// already the shape `terraform import` takes. Nothing rebuilds it downstream.
	check(
		'a swept row carries no ARN, because the API answers none',
		swept.every((i) => !i.arn),
		JSON.stringify(swept.filter((i) => i.arn))
	);

	// -------------------------------------------- layer 1a: what is NOT an error
	//
	// Of the ~770 AWS types, a couple hundred never list. Reporting one error each
	// would bury the failures a person can act on, and would make a complete scan
	// read as a broken one.
	const sources = out.errors.map((e) => e.message).join(' | ');
	check(
		'a type with no LIST handler is not reported as an error',
		!/does not support LIST/.test(sources),
		sources
	);
	check(
		'nor is one that refuses without a parent id',
		!/required key/.test(sources),
		sources
	);
	check(
		'but a denied call still is -- that difference is the point',
		/cloudformation:ListResources/.test(sources),
		sources
	);

	// ------------------------------------------------ layer 1a: S3's own region
	check('a bucket in the scanned region came', !!byId('bucket-aqui'), JSON.stringify(swept));
	check(
		'a bucket in another region was dropped, though S3 listed it anyway',
		!byId('bucket-noutra-regiao'),
		JSON.stringify(swept.map((i) => i.importId))
	);
	// The quirk that would eat every us-east-1 bucket in silence: AWS answers null
	// there, not the region name. `bucket-aqui` answers null and the scan is of
	// us-east-1, so keeping it is the assertion.
	check(
		'a null LocationConstraint was read as us-east-1, not as "no region"',
		!!byId('bucket-aqui')
	);

	// -------------------------------------- layer 1a: which globals belong here
	//
	// IAM has no region, so a sweep of one region answers for the whole account.
	// On a real account that is most of the answer, and it buries the handful the
	// person is looking for -- measured in mx-central-1 on 2026-08-26: 391 global
	// rows against 18 that were actually in the region.
	//
	// Dropping them is wrong, because the role a function runs as is one of them.
	// So each candidate is asked what it USES, and what it names gets marked.
	const roleUsed = out.items.find((i) => i.importId === 'cost-report-role');
	const roleIdle = out.items.find((i) => i.importId === 'nada-a-ver-role');

	check(
		'the role the function names is marked as used by it',
		roleUsed?.referencedBy?.includes('cost-report'),
		JSON.stringify(roleUsed)
	);
	// THE CONTROL, and the whole point: a role nobody named stays unmarked. Marking
	// everything would satisfy the assertion above just as well.
	check(
		'and a role nobody names is left unmarked',
		!roleIdle?.referencedBy,
		JSON.stringify(roleIdle)
	);
	// ------------------------------------------- what could NOT be read, and why
	//
	// This used to be invisible. On a real account 55 of 78 reads came back empty and
	// the run reported one error, because every failure counted as expected. The
	// person choosing resources pays for that: an unread candidate is one whose
	// references were never followed, so whatever it uses is offered as an anonymous
	// row among hundreds.
	check(
		'the candidate that could not be read is counted',
		out.detailUnread?.count === 1,
		JSON.stringify(out.detailUnread)
	);
	check(
		'and the count says why, in a word someone can act on',
		out.detailUnread?.by?.['not allowed'] === 1,
		JSON.stringify(out.detailUnread)
	);
	// A COUNT WITH NO NAMES CANNOT BE CHECKED. `no longer there: 1` came back
	// identical from two scans half an hour apart -- which is not a resource
	// disappearing mid-scan, but something that answers LIST and refuses to be
	// read, every time. There was no way to find out what.
	check(
		'and it names the candidate, so someone can go look',
		out.detailUnread?.who?.[0]?.importId === 'import-lab-items',
		JSON.stringify(out.detailUnread?.who)
	);
	check(
		'with its type and the same reason the tally counted',
		out.detailUnread?.who?.[0]?.cfnType === 'AWS::DynamoDB::Table' &&
			out.detailUnread?.who?.[0]?.reason === 'not allowed',
		JSON.stringify(out.detailUnread?.who)
	);
	// THE CONTROL: only the unread one is named. Listing every candidate would
	// satisfy the two checks above just as well.
	check(
		'and nothing that WAS read is named',
		out.detailUnread?.who?.length === 1,
		JSON.stringify(out.detailUnread?.who)
	);
	// THE CONTROL: a retry that never fired would leave the throttled read here too.
	check(
		'and the read that was merely rate limited is NOT among them',
		!out.detailUnread?.by?.['rate limited'],
		JSON.stringify(out.detailUnread)
	);

	check(
		'a candidate that names nothing marks nothing',
		!out.items.find((i) => i.importId === 'import-lab-processor')?.referencedBy,
		JSON.stringify(out.items.find((i) => i.importId === 'import-lab-processor'))
	);

	// -------------------------------------------------------------- layer 1b
	check('the VPC came, named by its tag', out.items.some((i) => i.tags?.Name === 'EKS-k8hub'));
	// `i.arn?.` and not `i.arn.`: the swept rows above have no ARN at all, so an
	// unguarded call here fails on the first one it reaches.
	check(
		'the subnet carries its vpcId, which the sweep cannot answer',
		out.items.find((i) => i.arn?.endsWith('subnet/subnet-a'))?.vpcId === 'vpc-0703'
	);
	check(
		"the NAT's address came marked as owned, so Struct8 can drop it knowingly",
		out.items.find((i) => i.arn?.endsWith('elastic-ip/eipalloc-0ded'))?.ownedBy === 'nat-0bce'
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

	// ------------------------------------------- the targets of an EventBridge rule
	const alvos = hints.filter((i) => i.terraformTypeHint === 'aws_cloudwatch_event_target');
	check(
		'the targets were expanded out of the rules, one per bus',
		alvos.length === 2,
		JSON.stringify(alvos)
	);
	// Two segments on the default bus, three on any other -- the same shape the
	// rule's own ARN has, and the same one Struct8 composes when it adopts.
	check(
		'a target on the default bus is <rule>/<target id>',
		alvos.find((a) => a.importId === 'import-lab3-daily/ingest-lambda') !== undefined,
		JSON.stringify(alvos.map((a) => a.importId))
	);
	check(
		'and on any other bus the bus comes first',
		alvos.find((a) => a.importId === 'barramento-de-pedidos/pedido-criado/notifica') !== undefined,
		JSON.stringify(alvos.map((a) => a.importId))
	);
	check(
		'a target with no id of its own was left out, not given one',
		!alvos.some((a) => a.importId.endsWith('/undefined') || a.importId.endsWith('/')),
		JSON.stringify(alvos.map((a) => a.importId))
	);
	check(
		'the name hint names the rule and the target, not the bus',
		alvos.find((a) => a.nameHint === 'import-lab3-daily_ingest-lambda') !== undefined,
		JSON.stringify(alvos.map((a) => a.nameHint))
	);

	// ----------------------------------------------------------- the failure
	check(
		'the service that refused is reported, not swallowed',
		out.errors.some((e) => e.source === 'ec2 describe-security-groups'),
		JSON.stringify(out.errors)
	);
	// Two, and only two: the denied sweep and the denied describe. If the types
	// that legitimately do not list ever start counting again, this catches it.
	check(
		'and nothing else was reported -- the expected refusals stayed out',
		out.errors.length === 2,
		JSON.stringify(out.errors)
	);
	check(
		'and the scan still produced everything else',
		out.items.length >= 8,
		`${out.items.length} item(s)`
	);

	// ------------------------------------------------- the flags actually sent
	const calls = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf-8'));

	// ------------------------------------------------ detail runs AFTER the region
	//
	// S3 lists the whole account whatever region is asked, so every bucket is a
	// candidate until its location says otherwise. Reading them first spends one
	// Cloud Control call per foreign bucket -- and Cloud Control is the same quota
	// the reads that matter are queueing for.
	const detalhe = calls.filter((c) => c.startsWith('cloudcontrol get-resource'));
	check(
		'a bucket in another region is never read in detail',
		!detalhe.some((c) => c.includes('bucket-noutra-regiao')),
		JSON.stringify(detalhe)
	);
	// THE CONTROL: skipping the detail pass entirely would satisfy that too.
	check(
		'and the bucket that IS in the region still is',
		detalhe.some((c) => c.includes('bucket-aqui')),
		JSON.stringify(detalhe)
	);
	check(
		'the rate limited read was asked a second time',
		detalhe.filter((c) => c.includes('AWS::Lambda::Function cost-report') || (c.includes('AWS::Lambda::Function') && c.includes('cost-report'))).length === 2,
		JSON.stringify(detalhe)
	);
	// Only the types Struct8 named are read one by one. Reading every swept row
	// would be one call per resource in the account -- thousands.
	check(
		'only the types asked for were read in detail',
		calls.some((c) => c.startsWith('cloudcontrol get-resource') && c.includes('AWS::Lambda::Function')) &&
			!calls.some((c) => c.startsWith('cloudcontrol get-resource') && c.includes('AWS::IAM::Role')),
		JSON.stringify(calls.filter((c) => c.startsWith('cloudcontrol get-resource')))
	);
	// The owner filter, which is the whole reason it is asked of IAM: Cloud Control
	// would answer the account's 93 policies alongside AWS's 1574, over seventeen
	// pages, and everything AWS owns would be dropped further along regardless.
	check(
		'a type AWS fills with its own catalogue is asked of the service that can filter by owner',
		calls.some((c) => c.startsWith('iam list-policies') && c.includes('--scope Local')),
		JSON.stringify(calls.filter((c) => c.startsWith('iam ')))
	);
	check(
		'and the sweep does not ask Cloud Control for it as well',
		!calls.some(
			(c) => c.startsWith('cloudcontrol list-resources') && c.includes('AWS::IAM::ManagedPolicy')
		),
		JSON.stringify(calls.filter((c) => c.includes('ManagedPolicy')))
	);
	// THE CONTROL: dropping the type entirely would satisfy both checks above and
	// lose every policy the account actually wrote.
	check(
		"and the account's own policy is in the inventory",
		out.items.some((i) => i.importId === 'arn:aws:iam::262578989263:policy/deploy-can-write'),
		JSON.stringify(out.items.filter((i) => i.cfnType === 'AWS::IAM::ManagedPolicy'))
	);

	// The two passes overlap. `calls.json` keeps the order they went out in, so the
	// question "did a read start before the listing finished" is answerable here:
	// a detail read must appear before the LAST listing, which cannot happen if the
	// read waits for the sweep to end.
	//
	// It is worth asserting because the passes ask different Cloud Control
	// operations, and those have separate rate capacity -- measured 2026-09-06 on
	// 60 types and 60 roles, 12.3 s of listings and 14.7 s of reads took 16.0 s
	// together against 27.1 s one after the other.
	const lastList = calls.findLastIndex((c) => c.startsWith('cloudcontrol list-resources'));
	const firstRead = calls.findIndex((c) => c.startsWith('cloudcontrol get-resource'));
	check(
		'a detail read goes out before the sweep has finished listing',
		firstRead !== -1 && lastList !== -1 && firstRead < lastList,
		`primeira leitura em ${firstRead}, ultima listagem em ${lastList}`
	);

	// Kept for the second run below, which asserts something about THIS one: the
	// directory is gone by then.
	callsFromMainRun = calls;
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

// ---------------------------------------------------------- a second scan, by tag
//
// The tagging API stopped being the default path and did not stop existing: it is
// the only call that can answer "which resources carry this tag", and `tagFilters`
// is a scope input. Kept alive here so that a later cleanup does not remove it
// believing nothing uses it.
//
// Its two defects come back with it -- silent about the untagged, still answering
// for the destroyed -- and that is the trade of asking for a tag filter.
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'struct8-scan-tag-'));
try {
	const ANSWERS_TAG = {
		'resourcegroupstaggingapi get-resources': [
			{
				ResourceTagMappingList: [
					{
						ResourceARN: `arn:aws:eks:${R}:${A}:cluster/eks-k8hub`,
						Tags: [{ Key: 'Project', Value: 'k8hub' }]
					}
				],
				PaginationToken: ''
			}
		],
		'sts get-caller-identity': [{ Account: A }]
	};
	const stubTag = stub.replace(
		`const __ANSWERS = ${JSON.stringify(ANSWERS)};`,
		`const __ANSWERS = ${JSON.stringify(ANSWERS_TAG)};`
	);
	if (stubTag === stub) {
		check('the tag-run stub was built from the same shape as the main one', false);
	}

	fs.writeFileSync(path.join(dir2, 'scan-account.mjs'), patched(stubTag));
	// No vpcIds and no cfnTypes: this run is ONLY the tag path, so anything that
	// shows up came from it.
	fs.writeFileSync(
		path.join(dir2, 'scan_scope.json'),
		JSON.stringify({ region: R, vpcIds: [], tagFilters: ['Project=k8hub'], cfnTypes: [] })
	);
	execFileSync('node', ['scan-account.mjs'], { cwd: dir2, encoding: 'utf-8', stdio: 'pipe' });

	const out2 = JSON.parse(fs.readFileSync(path.join(dir2, 'scan_inventory.json'), 'utf-8'));
	const calls2 = JSON.parse(fs.readFileSync(path.join(dir2, 'calls.json'), 'utf-8'));

	check(
		'a tag filter still reaches the tagging API',
		calls2.some((c) => c.startsWith('resourcegroupstaggingapi get-resources') && c.includes('Key=Project,Values=k8hub')),
		JSON.stringify(calls2)
	);
	check(
		'and what it answered is in the inventory',
		out2.items.some((i) => i.arn === `arn:aws:eks:${R}:${A}:cluster/eks-k8hub`),
		JSON.stringify(out2.items)
	);
	// The inverse, and the one that would rot quietly: with no tag filter the main
	// run above must never call it. If it does, the old index is back in the
	// default path and the untagged are invisible again.
	check(
		'and a scan with no tag filter never calls it at all',
		!callsFromMainRun.some((c) => c.startsWith('resourcegroupstaggingapi')),
		JSON.stringify(callsFromMainRun.filter((c) => c.startsWith('resourcegroupstaggingapi')))
	);
	check(
		'an empty type list is reported, so a silent half-scan is impossible',
		out2.errors.some((e) => /No type list to sweep/.test(e.message)),
		JSON.stringify(out2.errors)
	);
	// THE TARGET FOLLOWS ITS PARENT'S SCOPE. This run asks for no type at all, so
	// no rule reaches the diagram -- and a target expanded here would name a rule
	// that is not there. The calls must not happen either: `ANSWERS_TAG` holds no
	// answer for them, so an ungated block would show up as recorded errors rather
	// than as a crash, which is the quiet way this would rot.
	check(
		'with no rule in the sweep, EventBridge is never asked',
		!calls2.some((c) => c.startsWith('events ')),
		JSON.stringify(calls2.filter((c) => c.startsWith('events ')))
	);
} finally {
	fs.rmSync(dir2, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
