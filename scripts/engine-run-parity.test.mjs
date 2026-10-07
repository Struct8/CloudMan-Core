// Fails when `.github/actions/engine-run/action.yml` stops being the job of
// `.github/workflows/engine.yml`, step for step. Run:
//   node scripts/engine-run-parity.test.mjs
//
// WHY. The action exists so the engine can run on a runner the customer's own
// repository names (a CodeBuild project), which `engine.yml` cannot do: it
// fixes `runs-on: ubuntu-latest`. The two files are then two copies of the same
// job, and a fix that lands in only one of them makes runs behave differently
// depending on the machine that picked them up -- with nothing in either log
// saying so.
//
// WHAT IS COMPARED. Each step of engine.yml's job against the step at the same
// position in the action, after dropping blank and comment-only lines and the
// indentation difference (steps sit 6 spaces deep in a job and 4 in an action),
// and after the substitutions below, which a composite action needs because it
// cannot read the `secrets` context. Nothing else may differ: not a name, not
// the order, not an `if:`, not a pinned SHA.
//
// No YAML library, on purpose: this repository has no dependencies, and
// comparing lines is stricter than comparing parsed trees, which would accept
// two spellings of the same value.
//
// ENGINE_YML and ENGINE_ACTION override the two paths, which is how the test is
// shown to fail on a copy with one step changed.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_YML = resolve(ROOT, process.env.ENGINE_YML || '.github/workflows/engine.yml');
const ENGINE_ACTION = resolve(ROOT, process.env.ENGINE_ACTION || '.github/actions/engine-run/action.yml');

/** engine.yml spelling -> action spelling. The only differences allowed. */
const SUBSTITUTIONS = [
	['secrets.GITHUB_TOKEN', 'github.token'],
	['toJSON(secrets)', 'inputs.secrets_json'],
];

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

function linesOf(path) {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n');
}

function meaningful(line) {
	const t = line.trim();
	return t !== '' && !t.startsWith('#');
}

/**
 * The items of the YAML list that starts right after `header`, each as its
 * lines with `indent` spaces removed. Blank and comment-only lines are dropped,
 * inside `run:` scripts too -- a shell comment changes nothing a step does.
 */
function listAfter(lines, header, indent) {
	const start = lines.indexOf(header);
	if (start < 0) throw new Error(`no line '${header}'`);
	const pad = ' '.repeat(indent);
	const items = [];
	for (const line of lines.slice(start + 1)) {
		if (!meaningful(line)) continue;
		if (!line.startsWith(pad)) break;
		const body = line.slice(indent);
		if (body.startsWith('- ')) items.push([]);
		if (items.length === 0) throw new Error(`content before the first item of '${header}': ${line}`);
		items[items.length - 1].push(body);
	}
	return items;
}

/** `name -> default` for the entries of a mapping that starts after `header`. */
function defaultsAfter(lines, header, indent) {
	const start = lines.indexOf(header);
	if (start < 0) throw new Error(`no line '${header}'`);
	const pad = ' '.repeat(indent);
	const out = new Map();
	let current = null;
	for (const line of lines.slice(start + 1)) {
		if (!meaningful(line)) continue;
		if (!line.startsWith(pad)) break;
		const body = line.slice(indent);
		if (!body.startsWith(' ')) {
			current = body.replace(/:.*$/, '');
			out.set(current, undefined);
			continue;
		}
		const m = body.trim().match(/^default:\s*(.*)$/);
		if (m && current) out.set(current, m[1]);
	}
	return out;
}

const substitute = (line) => SUBSTITUTIONS.reduce((s, [from, to]) => s.replaceAll(from, to), line);
const nameOf = (step) => step[0].replace(/^- name:\s*/, '');

const engineLines = linesOf(ENGINE_YML);
const actionLines = linesOf(ENGINE_ACTION);
const engineSteps = listAfter(engineLines, '    steps:', 6).map((step) => step.map(substitute));
const actionSteps = listAfter(actionLines, '  steps:', 4);

console.log('the action is a composite one');
check('runs.using is composite', actionLines.includes('  using: composite'));

console.log('\nthe same steps, in the same order');
check(
	`engine.yml has ${engineSteps.length} steps, the action ${actionSteps.length}`,
	engineSteps.length === actionSteps.length,
	`engine.yml: ${engineSteps.map(nameOf).join(' | ')}\n       action:     ${actionSteps.map(nameOf).join(' | ')}`
);
const count = Math.min(engineSteps.length, actionSteps.length);
for (let i = 0; i < count; i++) {
	const a = engineSteps[i];
	const b = actionSteps[i];
	const at = a.findIndex((line, j) => line !== b[j]);
	const differs = at !== -1 || a.length !== b.length;
	const where = at !== -1 ? at : Math.min(a.length, b.length);
	check(
		`step ${i + 1}: ${nameOf(a)}`,
		!differs,
		differs
			? `first difference at line ${where + 1} of the step:\n       engine.yml: ${a[where] ?? '(nothing)'}\n       action:     ${b[where] ?? '(nothing)'}`
			: ''
	);
}

console.log('\nno secret left that the action cannot read');
{
	// The `secrets` context itself -- `secrets.X`, `(secrets)`, `secrets }}` --
	// and not a name that merely contains the word, like `inputs.secrets_json`.
	const context = /(^|[^A-Za-z0-9_.])secrets\s*(\.|\)|\}\})/;
	const left = engineSteps.flat().filter((line) => context.test(line));
	check(
		'every use of `secrets` in engine.yml has a substitution',
		left.length === 0,
		`add a substitution, and an input to the action if it is a new value:\n       ${left.join('\n       ')}`
	);
}

console.log('\nthe inputs');
{
	const engineInputs = defaultsAfter(engineLines, '    inputs:', 6);
	const actionInputs = defaultsAfter(actionLines, 'inputs:', 2);
	for (const [name, value] of engineInputs) {
		check(
			`'${name}' exists in the action with engine.yml's default (${value})`,
			actionInputs.has(name) && actionInputs.get(name) === value,
			actionInputs.has(name) ? `action default: ${actionInputs.get(name)}` : 'missing from the action'
		);
	}
	check("'secrets_json' is declared", actionInputs.has('secrets_json'));
	const used = new Set([...actionSteps.flat().join('\n').matchAll(/inputs\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
	for (const name of used) {
		check(`'inputs.${name}' used by a step is declared`, actionInputs.has(name));
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
