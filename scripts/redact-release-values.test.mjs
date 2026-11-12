// Exercises redact-release-values.mjs on a plan JSON shaped as the read pass
// writes it for an imported `helm_release` (hashicorp/helm 2.12.1, k8simp lab,
// 12/11/2026), cut down.
//
// Usage:
//   node scripts/redact-release-values.test.mjs

import { redactReleaseValues } from './redact-release-values.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${detail}`);
		failures++;
	}
}

const SECRET = '{"concurrent":2,"webhook":{"password":"s3cr3t"}}';
const release = (values) => ({
	name: 'external-secrets',
	namespace: 'external-secrets',
	chart: 'external-secrets',
	version: '2.15.0',
	values: null,
	metadata: [{ name: 'external-secrets', chart: 'external-secrets', version: '2.15.0', revision: 1, values }]
});

function plan() {
	return {
		format_version: '1.2',
		planned_values: {
			root_module: {
				resources: [
					{ address: 'helm_release.app_external_secrets', mode: 'managed', type: 'helm_release', name: 'app_external_secrets', values: release(SECRET) },
					{ address: 'kubernetes_namespace.argocd', mode: 'managed', type: 'kubernetes_namespace', name: 'argocd', values: { metadata: [{ name: 'argocd', labels: { name: 'argocd' } }] } }
				],
				child_modules: [
					{ resources: [{ address: 'module.m.helm_release.x', mode: 'managed', type: 'helm_release', name: 'x', values: release('{"a":1}') }] }
				]
			}
		},
		resource_changes: [
			{
				address: 'helm_release.app_external_secrets',
				type: 'helm_release',
				change: { actions: ['no-op'], importing: { id: 'external-secrets/external-secrets' }, before: release(SECRET), after: release(SECRET) }
			}
		],
		prior_state: {
			values: {
				root_module: {
					resources: [{ address: 'helm_release.app_external_secrets', mode: 'managed', type: 'helm_release', name: 'app_external_secrets', values: release(SECRET) }]
				}
			}
		},
		redacted_attributes: ['aws_ssm_parameter.p.value']
	};
}

{
	const p = plan();
	const { removed } = redactReleaseValues(p);
	const text = JSON.stringify(p);
	check(
		'no value of any release is left anywhere in the file',
		!text.includes('s3cr3t') && !text.includes('"concurrent":2') && !text.includes('{\\"a\\":1}'),
		text.match(/s3cr3t|"concurrent":2|\{\\"a\\":1\}/)?.[0]
	);
	check('planned_values loses them', p.planned_values.root_module.resources[0].values.metadata[0].values === null);
	check('a child module too', p.planned_values.root_module.child_modules[0].resources[0].values.metadata[0].values === null);
	check('both sides of the change', p.resource_changes[0].change.before.metadata[0].values === null && p.resource_changes[0].change.after.metadata[0].values === null);
	check('and the prior state', p.prior_state.values.root_module.resources[0].values.metadata[0].values === null);
	check(
		'the rest of the release stays: name, namespace, chart and version',
		p.planned_values.root_module.resources[0].values.metadata[0].chart === 'external-secrets' && p.planned_values.root_module.resources[0].values.version === '2.15.0'
	);
	check('a resource of another type is not touched', p.planned_values.root_module.resources[1].values.metadata[0].labels.name === 'argocd');
	check(
		'what was removed is listed, after what the sensitive redaction listed',
		p.redacted_attributes[0] === 'aws_ssm_parameter.p.value' &&
			p.redacted_attributes.includes('helm_release.app_external_secrets.metadata.0.values') &&
			p.redacted_attributes.includes('module.m.helm_release.x.metadata.0.values'),
		JSON.stringify(p.redacted_attributes)
	);
	check(
		'the names of the top-level keys stay, without the values, for the import report',
		JSON.stringify(p.release_value_keys?.['helm_release.app_external_secrets']) === JSON.stringify(['concurrent', 'webhook']),
		JSON.stringify(p.release_value_keys)
	);
	check('the count is of the attributes removed, one per release', removed === 2, String(removed));
}

{
	const p = { planned_values: { root_module: { resources: [{ address: 'helm_release.a', type: 'helm_release', values: release(null) }] } } };
	redactReleaseValues(p);
	check('a release with no values adds nothing to redacted_attributes', p.redacted_attributes === undefined && p.release_value_keys === undefined, JSON.stringify(p));
}

{
	// The program, as pipeline.sh runs it: in place, on the file.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-release-'));
	const file = path.join(dir, 'generated_resources.json');
	fs.writeFileSync(file, JSON.stringify(plan()));
	const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
	execFileSync(process.execPath, [path.join(here, 'redact-release-values.mjs'), file], { stdio: 'pipe' });
	const written = fs.readFileSync(file, 'utf-8');
	check('run as a program, it rewrites the file without the values', !written.includes('s3cr3t') && JSON.parse(written).redacted_attributes.length === 3, written.slice(0, 120));
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
