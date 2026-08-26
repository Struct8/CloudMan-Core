// Exercises sanitize-generated-config.mjs without an AWS account.
//
// WHY THIS EXISTS. The repair loop in pipeline.sh re-plans against a real
// account between passes, so every regression in the sanitizer used to surface
// as "the import draft came back empty", minutes into a run, with the cause
// buried in a log nobody reads to the end. That is exactly how the ANSI defect
// survived a publish: pass 1 is structural and kept working, pass 2 matched
// nothing, and the symptom looked like the fix had not been deployed.
//
// HOW. The script is a program, not a module, so each case writes a config and
// a log to a temporary directory, runs it as a subprocess, and reads back what
// it wrote. That also pins the CLI contract the pipeline depends on: which
// argument order, and which exit code means "stop looping".
//
// WHAT IT DOES NOT COVER. That the provider still phrases its diagnostics this
// way, and that a repaired draft actually plans. Only a run against an account
// settles those. What this settles is the part that is ours.
//
// No dependencies and no runner on purpose, same as scan-account.test.mjs.
//
// Usage:
//   node scripts/sanitize-generated-config.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'sanitize-generated-config.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-test-'));

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${detail}`);
		failures++;
	}
}

/** ESC, built rather than typed: a raw one in the source is invisible. */
const ESC = String.fromCharCode(27);

/**
 * Runs the sanitizer over a config, optionally with a plan log.
 *
 * @param config the .tf contents
 * @param log the plan output, or undefined for pass 1
 * @returns { code, out, config } -- the exit code, stdout, and the file after
 */
function run(config, log) {
	const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
	const configPath = path.join(dir, 'generated_resources.tf');
	fs.writeFileSync(configPath, config, 'utf-8');

	const args = [SCRIPT, configPath];
	if (log !== undefined) {
		const logPath = path.join(dir, 'draft_plan.log');
		fs.writeFileSync(logPath, log, 'utf-8');
		args.push(logPath);
	}

	let code = 0;
	let out = '';
	try {
		out = execFileSync(process.execPath, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		code = e.status ?? 1;
		out = String(e.stdout ?? '') + String(e.stderr ?? '');
	}
	return { code, out, config: fs.readFileSync(configPath, 'utf-8') };
}

// ─────────────────────────────────────────────────────────── pass 1

const SUBNET = `resource "aws_subnet" "public" {
  availability_zone = "mx-central-1a"
  cidr_block        = "10.43.1.0/24"
  customer_owned_ipv4_pool = ""
  ipv6_cidr_block   = null
  secondary_ips     = []
  empty_map         = {}
  tags = {
    Name    = "public"
    Vazia   = ""
  }
  vpc_id = "vpc-1"
}
`;

{
	const r = run(SUBNET);
	check('pass 1 exits 0 when it changed something', r.code === 0, r.out);
	check('drops an empty string at resource level', !/customer_owned_ipv4_pool/.test(r.config));
	check('drops an empty list', !/secondary_ips/.test(r.config));
	check('drops an empty map', !/empty_map/.test(r.config));
	check('keeps a real value', /cidr_block\s+= "10.43.1.0\/24"/.test(r.config));
	check('keeps an explicit null', /ipv6_cidr_block\s+= null/.test(r.config));
	// A tag with an empty value is a value. Dropping it would make the plan want
	// to delete a tag off a live resource, which is the opposite of harmless.
	check('leaves an empty tag value alone', /Vazia\s+= ""/.test(r.config), r.config);
}

const ROUTE_TABLE = `resource "aws_route_table" "private" {
  propagating_vgws = []
  route = [{
    cidr_block           = "0.0.0.0/0"
    gateway_id           = ""
    ipv6_cidr_block      = ""
    network_interface_id = "eni-1"
    prefix_list_ids      = []
  }]
  vpc_id = "vpc-1"
}
`;

{
	const r = run(ROUTE_TABLE);
	// The object type of `route` declares every key. Dropping one trades the
	// CIDR error for "attributes ... are required", so the empty string becomes
	// null and the key stays.
	check('inside an object value, "" becomes null', /ipv6_cidr_block\s+= null/.test(r.config), r.config);
	check('and the key is not dropped', /gateway_id\s+= null/.test(r.config));
	check('an empty list inside the object is left alone', /prefix_list_ids\s+= \[\]/.test(r.config));
	check('but an empty list at resource level still goes', !/propagating_vgws/.test(r.config));
}

{
	const heredoc = `resource "aws_instance" "one" {
  user_data = <<-EOT
    empty = ""
    list  = []
  EOT
  spare = ""
}
`;
	const r = run(heredoc);
	check('a heredoc body is data, not HCL', /empty = ""/.test(r.config) && /list  = \[\]/.test(r.config), r.config);
	check('and the attribute after it is still cleaned', !/spare/.test(r.config));
}

{
	const r = run(`resource "aws_vpc" "v" {\n  cidr_block = "10.0.0.0/16"\n}\n`);
	check('pass 1 exits 1 when there is nothing to change', r.code === 1, r.out);
}

// ─────────────────────────────────────────────────────────── pass 2

const DIRTY = `resource "aws_subnet" "public" {
  availability_zone    = "mx-central-1a"
  availability_zone_id = "mxc1-az1"
  cidr_block           = "10.43.1.0/24"
  enable_lni_at_device_index = 0
  map_customer_owned_ip_on_launch = false
  private_dns_hostname_type_on_launch = ""
  route = [{
    cidr_block = "0.0.0.0/0"
  }]
}

resource "aws_subnet" "private" {
  availability_zone = "mx-central-1a"
  cidr_block        = "10.43.2.0/24"
}
`;

/** A diagnostic the way Terraform prints it: boxed, wrapped, and coloured. */
const diagnostic = (summary, address, detail, { colour = false, box = true } = {}) => {
	const paint = (s) => (colour ? `${ESC}[31m${s}${ESC}[0m` : s);
	const bar = box ? paint('│') + ' ' : '';
	const lines = [
		box ? paint('╷') : '',
		`${bar}${colour ? `${ESC}[1m${ESC}[31mError: ${ESC}[0m` : 'Error: '}${summary}`,
		`${bar}`,
		`${bar}  with ${address},`,
		`${bar}  on generated_resources.tf line 2:`,
		`${bar}  (source code not available)`,
		`${bar}`,
		...(detail ? detail.map((d) => `${bar}${d}`) : []),
		box ? paint('╵') : ''
	];
	return lines.filter((l) => l !== '' || box).join('\n') + '\n';
};

{
	const log =
		diagnostic('Conflicting configuration arguments', 'aws_subnet.public', [
			'"availability_zone": conflicts with availability_zone_id'
		]) +
		diagnostic('enable_lni_at_device_index must not be zero, got 0', 'aws_subnet.public') +
		diagnostic('Missing required argument', 'aws_subnet.public', [
			'"map_customer_owned_ip_on_launch": all of',
			'`customer_owned_ipv4_pool,map_customer_owned_ip_on_launch,outpost_arn` must',
			'be specified'
		]);
	const r = run(DIRTY, log);

	check('pass 2 exits 0 when it dropped something', r.code === 0, r.out);
	const publicBlock = r.config.slice(r.config.indexOf('"public"'), r.config.indexOf('"private"'));
	check('drops the quoted attribute', !/availability_zone\s+=/.test(publicBlock), publicBlock);
	check('drops the one named without quotes', !/enable_lni_at_device_index/.test(publicBlock));
	// The detail wraps over three lines at the terminal width; read line by line
	// the attribute and its `all of` clause never meet.
	check('reads a detail that wrapped across lines', !/map_customer_owned_ip_on_launch/.test(publicBlock));
	// Only the side that was quoted. The other arrives as its own diagnostic.
	check('leaves the unquoted side of the conflict', /availability_zone_id\s+=/.test(publicBlock), publicBlock);
	// Same attribute name, different resource: the address is what scopes it.
	const privateBlock = r.config.slice(r.config.indexOf('"private"'));
	check('does not touch another resource with the same attribute', /availability_zone\s+=/.test(privateBlock), privateBlock);
	check('never drops the line that opens a container', /route = \[\{/.test(publicBlock));
}

{
	// The regression that shipped: a coloured log. Read from the left, the first
	// character that is not punctuation is the `3` of `\x1b[31m`, so nothing
	// matched and the loop stopped one pass in.
	const log = diagnostic('Conflicting configuration arguments', 'aws_subnet.public', [
		'"availability_zone": conflicts with availability_zone_id'
	], { colour: true });
	const r = run(DIRTY, log);
	check('a coloured log parses', r.code === 0 && !/availability_zone\s+=/.test(r.config.slice(0, r.config.indexOf('"private"'))), r.out);
}

{
	const log = diagnostic('Conflicting configuration arguments', 'aws_subnet.public', [
		'"availability_zone": conflicts with availability_zone_id'
	], { box: false });
	const r = run(DIRTY, log);
	check('a log without the box parses too', r.code === 0, r.out);
}

{
	// `validation.StringInSlice` and its family name the attribute bare, and the
	// generator emits the zero value of an enum as readily as of anything else.
	const log = diagnostic(
		'expected private_dns_hostname_type_on_launch to be one of ["ip-name" "resource-name"], got ',
		'aws_subnet.public'
	);
	const r = run(DIRTY, log);
	check(
		'reads a validation error that names the attribute bare',
		r.code === 0 && !/private_dns_hostname_type_on_launch/.test(r.config),
		r.out
	);
}

{
	// The whole point of the exit code: it is what ends the loop in pipeline.sh.
	// A summary with no attribute in it must not spin.
	const log = diagnostic('"" is not a valid CIDR block: invalid CIDR address: ', 'aws_route_table.private');
	const r = run(DIRTY, log);
	check('exits 1 when the errors name no attribute', r.code === 1, r.out);

	const r2 = run(DIRTY, diagnostic('Something went wrong', 'aws_subnet.nao-existe', ['"whatever": conflicts with x']));
	check('exits 1 when the named resource is not in the file', r2.code === 1, r2.out);
}

{
	// THE LOCATION LINE LOOKS LIKE A BLAMED ATTRIBUTE. `on main.tf line 14, in
	// resource "google_storage_bucket_object" "content":` ends with the
	// resource's own name in quotes and a colon -- the exact shape this reads as
	// "the provider blamed this attribute". A resource called `content` lost its
	// `content`.
	//
	// It survived every aws case because those logical names carry hyphens,
	// which the attribute pattern excludes. Running the same parser against the
	// google provider, whose names do not, is what surfaced it -- so the case is
	// written with google's wording, which is the SDK's `ExactlyOneOf`.
	const config = `resource "google_storage_bucket_object" "content" {
  bucket  = "b"
  content = "oi"
  source  = "/tmp/a"
}
`;
	const log = [
		'Error: Invalid combination of arguments',
		'',
		'  with google_storage_bucket_object.content,',
		'  on main.tf line 14, in resource "google_storage_bucket_object" "content":',
		'  14:   source  = "/tmp/a"',
		'',
		'"source": only one of `content,source` can be specified, but',
		'`content,source` were specified.',
		''
	].join('\n');
	const r = run(config, log);
	check('drops what the provider blamed, across providers', !/source\s+=/.test(r.config), r.config);
	check('and not the resource name that has an attribute shape', /content = "oi"/.test(r.config), r.config);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ ALL CASES PASSED' : `\n❌ ${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
