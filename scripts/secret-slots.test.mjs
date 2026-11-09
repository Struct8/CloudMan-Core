// Runs the script of the "🚀 Run Modular Pipeline" step, of engine.yml and of
// .github/actions/engine-run/action.yml, and checks what reaches pipeline.sh:
//   node scripts/secret-slots.test.mjs
//
// WHY. That script builds SECRETS_CONTEXT, the secrets the pipeline may read,
// from the slots the customer's workflow fills (STRUCT8_SECRET_1 to 10) and the
// `secret_names` input that says which secret each slot holds. A mistake there
// does not fail loudly: a token left out shows up as "secret not found" in the
// middle of an apply, and a slot left in the environment reaches terraform,
// every provider and every local-exec.
//
// HOW. The step's script is taken from the file as written, and its last line,
// `bash .struct8-engine/scripts/pipeline.sh`, is replaced by a probe: a node
// process that reports the environment it inherited, which is the environment
// pipeline.sh would have. Each case runs under `bash -eo pipefail`, the shell
// GitHub runs a step in. Needs bash, jq and node, which GitHub's hosted image
// ships; it runs in engine-tests.yml on every pull request to a channel.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
	['engine.yml', join(ROOT, '.github/workflows/engine.yml')],
	['the action', join(ROOT, '.github/actions/engine-run/action.yml')],
];
const STEP = '- name: 🚀 Run Modular Pipeline';
const PIPELINE = 'bash .struct8-engine/scripts/pipeline.sh';
const SLOTS = Array.from({ length: 10 }, (_, i) => `STRUCT8_SECRET_${i + 1}`);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
	}
}

/** The `run: |` block of the step, dedented. */
function stepScript(path) {
	const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
	const start = lines.findIndex((line) => line.trim() === STEP);
	if (start < 0) throw new Error(`no step '${STEP}' in ${path}`);
	const runAt = lines.findIndex((line, i) => i > start && line.trim() === 'run: |');
	if (runAt < 0) throw new Error(`no 'run: |' after '${STEP}' in ${path}`);
	const runIndent = lines[runAt].search(/\S/);
	const body = [];
	for (const line of lines.slice(runAt + 1)) {
		if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
		body.push(line);
	}
	const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
	return body.map((l) => l.slice(indent)).join('\n');
}

const PROBE = `node -e 'const fs=require("fs");fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({context: process.env.SECRETS_CONTEXT ?? null, left: Object.keys(process.env).filter((k) => /^(STRUCT8_SECRET|SECRET_NAMES)/.test(k))}))'`;

const dir = mkdtempSync(join(tmpdir(), 'secret-slots-'));

/**
 * Runs the step with `vars` in its environment. Every slot is set, empty when
 * the case does not fill it, as GitHub sets every key of a step's `env:`.
 */
function run(script, vars) {
	const file = join(dir, 'step.sh');
	const out = join(dir, 'probe.json');
	rmSync(out, { force: true });
	writeFileSync(file, script.replace(PIPELINE, PROBE));
	const env = { PATH: process.env.PATH, PROBE_OUT: out, SECRET_NAMES: '', STRUCT8_SECRETS_JSON: '' };
	for (const slot of SLOTS) env[slot] = '';
	if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
	Object.assign(env, vars);
	const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], { env, cwd: dir, encoding: 'utf8' });
	let probe = null;
	try {
		probe = JSON.parse(readFileSync(out, 'utf8'));
	} catch {
		probe = null;
	}
	const masks = (r.stdout || '')
		.split(/\r?\n/)
		.filter((l) => l.startsWith('::add-mask::'))
		.map((l) => l.slice('::add-mask::'.length));
	return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', probe, masks };
}

const context = (r) => (r.probe?.context == null ? null : JSON.parse(r.probe.context));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const [label, path] of FILES) {
	const script = stepScript(path);
	console.log(`\n${label}`);

	check('the step ends by running the pipeline', script.includes(PIPELINE));

	{
		const r = run(script, {
			SECRET_NAMES: '{"STRUCT8_SECRET_1":"AUTH_CLOUDFLARE_A1","STRUCT8_SECRET_2":"AUTH_CLOUDFLARE_B2"}',
			STRUCT8_SECRET_1: 'token-a',
			STRUCT8_SECRET_2: 'token-b',
		});
		check('two named slots: the run goes on', r.status === 0, r.stderr || r.stdout);
		check(
			'the pipeline reads each secret under the name the slot holds',
			same(context(r), { AUTH_CLOUDFLARE_A1: 'token-a', AUTH_CLOUDFLARE_B2: 'token-b' }),
			r.probe?.context
		);
		check('each value is masked', r.masks.includes('token-a') && r.masks.includes('token-b'), r.masks.join(','));
		check('no slot and no name map reaches the pipeline', same(r.probe?.left, []), String(r.probe?.left));
	}

	{
		const r = run(script, {
			SECRET_NAMES: '{"STRUCT8_SECRET_1":"AUTH_CLOUDFLARE_A1","STRUCT8_SECRET_3":"AUTH_CLOUDFLARE_C3"}',
			STRUCT8_SECRET_1: 'token-a',
		});
		check(
			'a slot whose secret the repository lacks is left out, as before',
			r.status === 0 && same(context(r), { AUTH_CLOUDFLARE_A1: 'token-a' }),
			r.probe?.context ?? r.stderr
		);
	}

	{
		const r = run(script, {
			SECRET_NAMES: '{"STRUCT8_SECRET_10":"AUTH_CLOUDFLARE_J"}',
			STRUCT8_SECRET_10: 'token-j',
			STRUCT8_SECRET_1: 'not-named',
		});
		check(
			'slot 10 is a slot, and a slot no name points to is ignored',
			r.status === 0 && same(context(r), { AUTH_CLOUDFLARE_J: 'token-j' }),
			r.probe?.context ?? r.stderr
		);
	}

	{
		const value = `a "quoted" \\back\\slash $(touch PWNED) 'single' & ; |`;
		const r = run(script, { SECRET_NAMES: '{"STRUCT8_SECRET_1":"AUTH_X"}', STRUCT8_SECRET_1: value });
		check('a value with quotes, backslashes and shell syntax arrives intact', r.status === 0 && context(r)?.AUTH_X === value, r.probe?.context ?? r.stderr);
		check('and nothing in it runs', !existsSync(join(dir, 'PWNED')));
	}

	{
		const r = run(script, { STRUCT8_SECRETS_JSON: '{"AUTH_CLOUDFLARE_OLD":"token-old","OTHER":"x"}' });
		check(
			'a workflow of before (one JSON object, no names) still runs as it did',
			r.status === 0 && same(context(r), { AUTH_CLOUDFLARE_OLD: 'token-old', OTHER: 'x' }),
			r.probe?.context ?? r.stderr
		);
		check('and its values are masked', r.masks.includes('token-old'), r.masks.join(','));
	}

	{
		const r = run(script, {
			SECRET_NAMES: '{"STRUCT8_SECRET_1":"AUTH_CLOUDFLARE_A1"}',
			STRUCT8_SECRET_1: 'token-a',
			STRUCT8_SECRETS_JSON: '{"EVERYTHING":"leak"}',
		});
		check(
			'with names, the JSON object of before is ignored',
			r.status === 0 && same(context(r), { AUTH_CLOUDFLARE_A1: 'token-a' }),
			r.probe?.context ?? r.stderr
		);
	}

	{
		const r = run(script, {});
		check('no secret at all: an empty object, and the run goes on', r.status === 0 && same(context(r), {}), r.probe?.context ?? r.stderr);
	}

	for (const [what, names] of [
		['a name map that is not an object', '["STRUCT8_SECRET_1"]'],
		['a name map that is not JSON', 'STRUCT8_SECRET_1=AUTH_X'],
		['a slot this file does not declare', '{"STRUCT8_SECRET_11":"AUTH_X"}'],
		['a slot of another name', '{"GITHUB_TOKEN":"AUTH_X"}'],
		['a name with a space', '{"STRUCT8_SECRET_1":"AUTH X"}'],
		['a name with a line break', '{"STRUCT8_SECRET_1":"AUTH\\nX"}'],
		['an empty name', '{"STRUCT8_SECRET_1":""}'],
	]) {
		const r = run(script, { SECRET_NAMES: names, STRUCT8_SECRET_1: 'token-a', STRUCT8_SECRET_11: 'token-k' });
		check(`${what}: the run stops before the pipeline`, r.status !== 0 && r.probe === null, `exit ${r.status}`);
		check(`${what}: the log says why, and shows no value`, /❌/.test(r.stdout) && !r.stdout.includes('token-a'), r.stdout.trim());
	}
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
