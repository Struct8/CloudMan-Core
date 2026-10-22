// Cases for state-entries.mjs.
//
// The fixture is shaped after a real state: 952133486861/CDNMain on
// 2026-10-22, an AWS state whose CloudFront distribution had written a CNAME in
// a Cloudflare zone. The connection was removed from the diagram, the compile
// stopped sending the Cloudflare credential, and every plan, apply and destroy
// of that state then failed with Cloudflare's error 9106 ("Missing X-Auth-Key,
// X-Auth-Email or Authorization headers") on the record the state still held.
//
// Usage: node state-entries.test.mjs

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SCRIPT = path.join(HERE, 'state-entries.mjs');

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${detail}`);
		failures++;
	}
}

function run(args, input) {
	let code = 0;
	let out = '';
	let err = '';
	try {
		out = execFileSync(process.execPath, [SCRIPT, ...args], {
			input,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe']
		});
	} catch (e) {
		code = e.status ?? 1;
		out = String(e.stdout ?? '');
		err = String(e.stderr ?? '');
	}
	let json = null;
	try {
		json = JSON.parse(out);
	} catch {
		json = null;
	}
	return { code, out, err, json };
}

const ACCOUNT = 'bf9638139fc9b9a92fa0334ae15ac3ac';
const AWS = 'provider["registry.terraform.io/hashicorp/aws"]';
const CLOUDFLARE = 'provider["registry.terraform.io/cloudflare/cloudflare"]';

const STATE = {
	version: 4,
	terraform_version: '1.5.7',
	serial: 161,
	lineage: '18edb505-810e-3b2b-a16b-19f423cc93f2',
	resources: [
		{
			mode: 'data',
			type: 'cloudflare_zone',
			name: 'struct8',
			provider: CLOUDFLARE,
			instances: [
				{
					attributes: {
						id: '719dfb5768a225d400fc49e5e8a04f25',
						name: 'struct8.com',
						account: { id: ACCOUNT, name: "someone's Account" }
					}
				}
			]
		},
		{
			mode: 'managed',
			type: 'cloudflare_dns_record',
			name: 'cname_appb',
			provider: CLOUDFLARE,
			instances: [
				{
					attributes: {
						id: '8c3cf338def2c66ee5fe48e090f00ed9',
						name: 'appb.struct8.com',
						zone_id: '719dfb5768a225d400fc49e5e8a04f25'
					}
				}
			]
		},
		{
			mode: 'managed',
			type: 'aws_lambda_function',
			name: 'GetStageV2',
			provider: AWS,
			instances: [{ attributes: { id: 'GetStageV2', environment: [{ variables: { TOKEN: 's3cr3t-value' } }] } }]
		},
		{
			mode: 'managed',
			type: 'aws_instance',
			name: 'a',
			provider: AWS,
			instances: [{ index_key: 0, attributes: { id: 'i-0' } }, { index_key: 1, attributes: { id: 'i-1' } }]
		},
		{
			mode: 'managed',
			type: 'aws_instance',
			name: 'ab',
			provider: AWS,
			instances: [{ attributes: { id: 'i-ab' } }]
		},
		{
			module: 'module.net',
			mode: 'managed',
			type: 'aws_s3_bucket',
			name: 'b',
			provider: `${AWS}.acct_123456789012`,
			instances: [{ index_key: 'logs', attributes: { id: 'net-logs', password: 's3cr3t-value' } }]
		}
	]
};
const INPUT = JSON.stringify(STATE);

// ───────────────────────────────────────────────────────────── provider-use

const CF_SOURCE = 'registry.terraform.io/cloudflare/cloudflare';
const AWS_SOURCE = 'registry.terraform.io/hashicorp/aws';

{
	const r = run(['provider-use', CF_SOURCE], INPUT);
	check('provider-use answers with exit 0', r.code === 0, r.err);
	const lines = r.out.split('\n');
	check(
		'the first line holds the account, taken from the zone data source -- the record names only the zone',
		lines[0] === ACCOUNT,
		JSON.stringify(lines)
	);
	check(
		'the lines after it hold the DNS record, the one resource a plan has to reach',
		JSON.stringify(lines.slice(1).filter(Boolean)) === JSON.stringify(['cloudflare_dns_record.cname_appb']),
		JSON.stringify(lines)
	);
}

{
	const r = run(['provider-use', AWS_SOURCE], INPUT);
	const lines = r.out.split('\n');
	check('a provider with no Cloudflare account answers an empty first line', lines[0] === '', JSON.stringify(lines));
	check(
		'an aliased configuration is left out -- no credential can stand in for its missing block',
		!r.out.includes('module.net') && r.out.includes('aws_instance.a[0]'),
		r.out
	);
}

{
	const dataOnly = {
		resources: [
			{
				mode: 'data',
				type: 'cloudflare_zone',
				name: 'z',
				provider: CLOUDFLARE,
				instances: [{ attributes: { id: 'z', account: { id: ACCOUNT } } }]
			}
		]
	};
	const r = run(['provider-use', CF_SOURCE], JSON.stringify(dataOnly));
	check('a provider with only data sources answers nothing -- there is nothing to reach', r.code === 0 && r.out === '', r.out);
}

{
	const r = run(['provider-use', 'registry.terraform.io/hashicorp/google'], INPUT);
	check('a provider the state does not use answers nothing', r.code === 0 && r.out === '', r.out);
}

{
	const accounts = {
		resources: [
			{
				mode: 'managed',
				type: 'cloudflare_workers_kv_namespace',
				name: 'kv',
				provider: CLOUDFLARE,
				instances: [{ attributes: { id: 'ns', account_id: ACCOUNT } }]
			},
			{
				mode: 'managed',
				type: 'cloudflare_ruleset',
				name: 'r',
				provider: CLOUDFLARE,
				instances: [{ attributes: { id: 'r', account_id: 'not-an-account' } }]
			}
		]
	};
	const r = run(['provider-use', CF_SOURCE], JSON.stringify(accounts));
	check(
		'account_id counts, and a value that is not an account identifier does not',
		r.out.split('\n')[0] === ACCOUNT,
		r.out
	);
}

// ────────────────────────────────────────────────────────────────── resolve

{
	const r = run(['resolve', 'cloudflare_dns_record.cname_appb'], INPUT);
	check('resolve answers with exit 0', r.code === 0, r.err);
	check(
		'an exact address names that instance, with its type, provider and id',
		JSON.stringify(r.json?.matched) ===
			JSON.stringify([
				{
					address: 'cloudflare_dns_record.cname_appb',
					mode: 'managed',
					type: 'cloudflare_dns_record',
					provider: 'registry.terraform.io/cloudflare/cloudflare',
					id: '8c3cf338def2c66ee5fe48e090f00ed9'
				}
			]),
		r.out
	);
	check('and the serial and lineage come along, for the record of the change', r.json?.serial === 161 && r.json?.lineage === STATE.lineage, r.out);
}

{
	const r = run(['resolve', 'aws_instance.a'], INPUT);
	const addresses = (r.json?.matched ?? []).map((m) => m.address);
	check(
		'a resource with count names every instance',
		JSON.stringify(addresses) === JSON.stringify(['aws_instance.a[0]', 'aws_instance.a[1]']),
		r.out
	);
	check('and never a resource whose name only starts the same', !addresses.includes('aws_instance.ab'), r.out);
}

{
	const r = run(['resolve', 'module.net'], INPUT);
	check(
		'a module names everything inside it, with a string key in quotes',
		JSON.stringify((r.json?.matched ?? []).map((m) => m.address)) ===
			JSON.stringify(['module.net.aws_s3_bucket.b["logs"]']),
		r.out
	);
}

{
	const r = run(['resolve', 'aws_instance.a[1]', 'aws_instance.a'], INPUT);
	check(
		'an instance asked for twice is listed once',
		JSON.stringify((r.json?.matched ?? []).map((m) => m.address)) ===
			JSON.stringify(['aws_instance.a[1]', 'aws_instance.a[0]']),
		r.out
	);
}

// ────────────────────────────────────────────────────────────────── missing

{
	const r = run(['missing', 'aws_instance.a', 'cloudflare_dns_record.cname_appb', 'module.net'], INPUT);
	check('missing answers nothing when every address names something', r.code === 0 && r.out === '', r.out);
}

{
	const r = run(['missing', 'aws_instance.a', 'aws_s3_bucket.gone', '-state=other.tfstate', 'aws_instance.abc'], INPUT);
	check(
		'it lists, one per line, what names nothing -- a flag-shaped argument and a longer name included',
		r.out === 'aws_s3_bucket.gone\n-state=other.tfstate\naws_instance.abc\n',
		JSON.stringify(r.out)
	);
}

{
	const r = run(['resolve', 'data.cloudflare_zone.struct8'], INPUT);
	check(
		'a data source is addressed with its data. prefix',
		r.json?.matched?.[0]?.address === 'data.cloudflare_zone.struct8' && r.json?.matched?.[0]?.mode === 'data',
		r.out
	);
}

// ───────────────────────────────────────────────────────────────────── list

{
	const r = run(['list'], INPUT);
	check('list answers with exit 0', r.code === 0, r.err);
	check('list holds one row per instance', r.json?.resources?.length === 7, r.out);
	check(
		'every row carries exactly address, mode, type, provider and id',
		(r.json?.resources ?? []).every(
			(row) => JSON.stringify(Object.keys(row)) === JSON.stringify(['address', 'mode', 'type', 'provider', 'id'])
		),
		r.out
	);
}

// ────────────────────────────────────────── nothing but the whitelist leaves

for (const args of [
	['provider-use', CF_SOURCE],
	['provider-use', AWS_SOURCE],
	['missing', 'aws_lambda_function.GetStageV2', 'x.y'],
	['resolve', 'aws_lambda_function.GetStageV2', 'module.net'],
	['list']
]) {
	const r = run(args, INPUT);
	check(
		`${args[0]} prints no attribute value from the state`,
		r.code === 0 && !r.out.includes('s3cr3t-value') && !r.out.includes('appb.struct8.com'),
		r.out
	);
}

// ────────────────────────────────────────────────────────────── edge inputs

{
	const r = run(['missing', 'aws_s3_bucket.x'], '');
	check(
		'a state never written reads as empty: the address is missing, and the answer is still an answer',
		r.code === 0 && r.out === 'aws_s3_bucket.x\n',
		`${r.code} ${r.out} ${r.err}`
	);
}

{
	const r = run(['list'], 'not json');
	check('input that is not JSON exits 1', r.code === 1, `${r.code} ${r.out}`);
}

{
	const r = run(['wipe'], INPUT);
	check('an unknown question exits 1 before reading the state', r.code === 1 && r.out === '', `${r.code} ${r.out}`);
}

console.log();
if (failures === 0) {
	console.log('ALL CASES PASSED');
	process.exit(0);
}
console.log(`${failures} CASE(S) FAILED`);
process.exit(1);
