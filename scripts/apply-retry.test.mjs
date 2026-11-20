// Cases for apply-retry.mjs.
//
// The first log is shaped after the real one: run 44633521264 of
// Struct8/CloudManV2CICD, 2026-11-19, where Cloudflare answered "404 Not Found"
// to the read that follows the creation of five Workers custom domains. The
// account, ids and names are replaced; the layout, the colors and the error
// body are kept, because they are what the script reads.
//
// Usage: node apply-retry.test.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SCRIPT = path.join(HERE, 'apply-retry.mjs');
const WORK = mkdtempSync(path.join(tmpdir(), 'apply-retry-'));

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${detail}`);
		failures++;
	}
}

let fixture = 0;
function run(log) {
	let file = log;
	if (log !== null && !log.startsWith('@')) {
		file = path.join(WORK, `log-${++fixture}.txt`);
		writeFileSync(file, log);
	} else if (log !== null) {
		file = log.slice(1);
	}
	try {
		const out = execFileSync(process.execPath, file === null ? [SCRIPT] : [SCRIPT, file], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
		return { code: 0, out: out.trim() };
	} catch (e) {
		return { code: e.status ?? 1, out: String(e.stdout ?? '').trim() };
	}
}

// Terraform's colors, as the engine's log keeps them.
const R = '\x1b[31m';
const B = '\x1b[1m';
const Z = '\x1b[0m';

// One diagnostic in the box Terraform draws with color on.
function box(kind, title, body) {
	const color = kind === 'Error' ? R : '\x1b[33m';
	return [
		`${color}╷${Z}`,
		`${color}│${Z} ${Z}${B}${color}${kind}: ${Z}${Z}${B}${title}${Z}`,
		`${color}│${Z} `,
		...body.split('\n').map((line) => `${color}│${Z} ${Z}${line}`),
		`${color}│${Z} `,
		`${color}╵${Z}`
	].join('\n');
}

function cloudflare404(name, id) {
	return box(
		'Error',
		'failed to make http request',
		[
			`  with cloudflare_workers_custom_domain.${name},`,
			`  on compute.tf line 11, in resource "cloudflare_workers_custom_domain" "${name}":`,
			`  11: resource "cloudflare_workers_custom_domain" "${name}" {`,
			'',
			'GET',
			`"https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/workers/domains/${id}":`,
			'404 Not Found {',
			'  "result": null,',
			'  "success": false,',
			'  "errors": [',
			'    {',
			'      "code": 100114,',
			`      "message": "Origin '${id}' not found."`,
			'    }',
			'  ],',
			'  "messages": []',
			'}'
		].join('\n')
	);
}

function aws(address, op, status, code, message) {
	return box(
		'Error',
		`${op}: operation error: https response error StatusCode: ${status}, RequestID: 00000000-0000-0000-0000-000000000000, ${code}: ${message}`,
		`  with ${address},\n  on main.tf line 4, in resource:\n   4: resource {`
	);
}

// What the apply printed before the errors. A "404" in an id or a name here is
// not a status.
const PROGRESS = [
	'cloudflare_workers_custom_domain.app_example_com: Creating...',
	'aws_s3_bucket.logs404: Creation complete after 2s [id=logs-404-bucket]',
	'aws_api_gateway_usage_plan.main: Creation complete after 1s [id=404abc]',
	''
].join('\n');

// ---------------------------------------------------------------- transient

{
	const log = [
		PROGRESS,
		cloudflare404('app_example_com', 'e899d57d3cb8bced9761a9fa2c0eeaa041c84c08'),
		cloudflare404('api_example_com', '1f0e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'),
		cloudflare404('www_example_com', 'aa11bb22cc33dd44ee55ff6600112233445566778'),
		cloudflare404('mcp_example_com', 'bb22cc33dd44ee55ff660011223344556677889900'),
		cloudflare404('docs_example_com', 'cc33dd44ee55ff6600112233445566778899aabbcc')
	].join('\n');
	const r = run(log);
	check('the run of 2026-11-19 (five 404s from Cloudflare) is retried', r.code === 0, r.out);
	check(
		'the reason names the status and the first resource',
		r.out.startsWith('404 Not Found on cloudflare_workers_custom_domain.app_example_com'),
		r.out
	);
	check('the reason counts the other four', r.out.endsWith('and 4 more transient errors'), r.out);

	const downloaded = run(log.replaceAll('\x1b', '^['));
	check('the same log as GitHub stores it ("^[" for the escape byte) is read the same', downloaded.out === r.out, downloaded.out);
}

for (const [status, code] of [
	[429, 'TooManyRequestsException'],
	[500, 'InternalFailure'],
	[502, 'BadGateway'],
	[503, 'ServiceUnavailable'],
	[504, 'GatewayTimeout']
]) {
	const r = run(PROGRESS + aws('aws_lambda_function.api', 'creating Lambda Function (api)', status, code, 'try again'));
	check(`AWS StatusCode: ${status} is retried`, r.code === 0, r.out);
}

{
	const r = run(
		PROGRESS +
			box(
				'Error',
				'Error creating Backend Service: googleapi: Error 503: Backend error, backendError',
				'  with google_compute_backend_service.web,\n  on network.tf line 2'
			)
	);
	check('Google "googleapi: Error 503" is retried', r.code === 0, r.out);
}

{
	const r = run(
		PROGRESS +
			box(
				'Error',
				'creating Storage Account: unexpected status 404 (404 Not Found) with error: ResourceGroupNotFound',
				'  with azurerm_storage_account.data,'
			)
	);
	check('Azure "unexpected status 404 (404 Not Found)" is retried', r.code === 0, r.out);
}

{
	const r = run(
		PROGRESS +
			box(
				'Error',
				'reading S3 Bucket (logs): RequestError: send request failed',
				'  with aws_s3_bucket.logs,\n\ncaused by: Get "https://s3.amazonaws.com/logs": read tcp 10.0.0.1:443: read: connection reset by peer'
			)
	);
	check('a connection reset, with no status, is retried', r.code === 0, r.out);
	check('the reason names the network error', r.out.startsWith('connection reset by peer on aws_s3_bucket.logs'), r.out);
}

{
	const log = [
		PROGRESS,
		'Error: failed to make http request',
		'',
		'  with cloudflare_workers_custom_domain.app_example_com,',
		'',
		'GET "https://api.cloudflare.com/client/v4/accounts/x/workers/domains/y":',
		'404 Not Found {"success": false}',
		''
	].join('\n');
	const r = run(log);
	check('without color (no box) the diagnostic is still read', r.code === 0, r.out);
}

{
	const log =
		PROGRESS +
		box('Warning', 'Argument is deprecated', '  with aws_s3_bucket.logs,\n\nStatusCode: 400 in an example') +
		'\n' +
		cloudflare404('app_example_com', 'e899d57d3cb8bced9761a9fa2c0eeaa041c84c08');
	const r = run(log);
	check('a warning beside a transient error does not block the retry', r.code === 0, r.out);
}

// ------------------------------------------------------------ not transient

{
	const r = run(
		PROGRESS +
			aws(
				'aws_api_gateway_usage_plan_key.main',
				'creating API Gateway Usage Plan Key',
				409,
				'ConflictException',
				'Usage Plan Key already exists'
			)
	);
	check('409 (the usage plan key of run 44639125819) is not retried', r.code === 1, r.out);
	check('the reason names the 409 and the resource', r.out === 'not transient: 409 Conflict on aws_api_gateway_usage_plan_key.main', r.out);
}

for (const [status, code] of [
	[400, 'ValidationException'],
	[401, 'UnrecognizedClientException'],
	[403, 'AccessDeniedException'],
	[422, 'UnprocessableEntity']
]) {
	const r = run(PROGRESS + aws('aws_lambda_function.api', 'creating Lambda Function (api)', status, code, 'no'));
	check(`AWS StatusCode: ${status} is not retried`, r.code === 1, r.out);
}

{
	const log =
		PROGRESS +
		cloudflare404('app_example_com', 'e899d57d3cb8bced9761a9fa2c0eeaa041c84c08') +
		'\n' +
		aws('aws_iam_role.app', 'creating IAM Role (app)', 403, 'AccessDenied', 'not authorized');
	const r = run(log);
	check('a 404 beside a 403 is not retried: the 403 fails again', r.code === 1, r.out);
	check('the reason names the 403', r.out.includes('403 Forbidden on aws_iam_role.app'), r.out);
}

{
	const log =
		PROGRESS +
		box(
			'Error',
			'Reference to undeclared resource',
			'  on main.tf line 9, in resource "aws_lambda_function" "api":\n   9:   role = aws_iam_role.app404.arn'
		);
	const r = run(log);
	check('an error with no HTTP status is not retried, even with "404" in the log', r.code === 1, r.out);
	check(
		'the reason quotes the error title',
		r.out === 'not transient: "Reference to undeclared resource" (no HTTP status)',
		r.out
	);
}

{
	const r = run(
		PROGRESS +
			box('Error', 'creating thing', '  with aws_instance.web,\n\nthe body says 404 Gateway Timeout, which is no status line')
	);
	check('a code with a phrase that is not its own is not a status', r.code === 1, r.out);
}

{
	const r = run(PROGRESS + box('Warning', 'Argument is deprecated', '  with aws_s3_bucket.logs,'));
	check('a log with warnings only is not retried', r.code === 1, r.out);
	check('the reason says no error was found', r.out === 'no Terraform error in the log', r.out);
}

{
	const r = run('');
	check('an empty log is not retried', r.code === 1, r.out);
}

{
	const log = cloudflare404('app_example_com', 'e899d57d3cb8bced9761a9fa2c0eeaa041c84c08')
		.split('\n')
		.slice(0, -1)
		.join('\n');
	const r = run(log);
	check('a log cut before the closing line still reads the error', r.code === 0, r.out);
}

// -------------------------------------------------------------------- usage

{
	const r = run(`@${path.join(WORK, 'missing.txt')}`);
	check('a log that cannot be read exits 2', r.code === 2, r.out);
}

{
	const r = run(null);
	check('no argument exits 2', r.code === 2, r.out);
}

rmSync(WORK, { recursive: true, force: true });

if (failures) {
	console.log(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log('\nAll checks passed.');
