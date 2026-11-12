// Exercises scan-cluster.mjs without a cluster.
//
// HOW. The script exports `scanCluster(scope, run, kubeconfig)`, and `run` is the one
// door to the outside world (`aws`, `helm`, `kubectl`). The test hands it a table of
// canned answers, shaped as those three commands answer, and records every call.
//
// WHAT IT DOES NOT COVER. That the real commands accept these flags and answer with
// these field names. The answers below were taken from the k8simp lab (12/11/2026,
// helm 3, EKS 1.37) and cut down; only a run against a cluster settles the rest.
//
// No dependencies and no runner, like scan-account.test.mjs.
//
// Usage:
//   node scripts/scan-cluster.test.mjs

import { readScope, scanCluster } from './scan-cluster.mjs';
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

const KUBECONFIG = '/tmp/struct8-cluster-test/kubeconfig';
const SCOPE = { cluster: 'k8simp-cluster', region: 'us-west-2', requestId: 'req-1' };

// `helm list -A -o json`: chart and version joined into one string.
const HELM_LIST = [
	{ name: 'external-secrets', namespace: 'external-secrets', revision: '1', status: 'deployed', chart: 'external-secrets-2.15.0', app_version: 'v2.15.0' },
	{ name: 'csi-secrets-store', namespace: 'kube-system', revision: '1', status: 'deployed', chart: 'secrets-store-csi-driver-1.6.2', app_version: '1.6.2' },
	{ name: 'argocd', namespace: 'argocd', revision: '1', status: 'deployed', chart: 'argo-cd-10.18.0', app_version: 'v3.2.0' },
	// A version with a hyphen: `my-chart-1.0.0-rc.1` cannot be split back with confidence.
	{ name: 'canary', namespace: 'app-a', revision: '2', status: 'failed', chart: 'my-chart-1.0.0-rc.1', app_version: '1.0.0' }
];

// `helm get metadata <name> -n <ns> -o json`, per release.
const METADATA = {
	'external-secrets/external-secrets': { name: 'external-secrets', chart: 'external-secrets', version: '2.15.0', appVersion: 'v2.15.0', namespace: 'external-secrets', revision: 1, status: 'deployed' },
	'kube-system/csi-secrets-store': { name: 'csi-secrets-store', chart: 'secrets-store-csi-driver', version: '1.6.2', appVersion: '1.6.2', namespace: 'kube-system', revision: 1, status: 'deployed' },
	'argocd/argocd': { name: 'argocd', chart: 'argo-cd', version: '10.18.0', appVersion: 'v3.2.0', namespace: 'argocd', revision: 1, status: 'deployed' },
	'app-a/canary': { name: 'canary', chart: 'my-chart', version: '1.0.0-rc.1', appVersion: '1.0.0', namespace: 'app-a', revision: 2, status: 'failed' }
};

// `kubectl get namespaces -o json`, with the fields the listing drops.
const NAMESPACES = {
	apiVersion: 'v1',
	kind: 'List',
	items: [
		{ metadata: { name: 'argocd', uid: 'u1', resourceVersion: '10', creationTimestamp: '2026-11-12T12:40:00Z', labels: { 'kubernetes.io/metadata.name': 'argocd', name: 'argocd' } }, spec: { finalizers: ['kubernetes'] }, status: { phase: 'Active' } },
		{ metadata: { name: 'app-a', uid: 'u2', labels: { 'kubernetes.io/metadata.name': 'app-a' }, annotations: { 'example.com/owner': 'platform' } }, status: { phase: 'Active' } },
		{ metadata: { name: 'kube-system', uid: 'u3' }, status: { phase: 'Active' } }
	]
};

function fakeRun({ failMetadataOf = null, failList = null, failKubeconfig = null } = {}) {
	const calls = [];
	const run = (command, args) => {
		calls.push([command, ...args]);
		if (command === 'aws') {
			if (failKubeconfig) throw Object.assign(new Error('exit 254'), { stderr: failKubeconfig });
			return '';
		}
		if (command === 'helm' && args[0] === 'list') {
			if (failList) throw Object.assign(new Error('exit 1'), { stderr: failList });
			return JSON.stringify(HELM_LIST);
		}
		if (command === 'helm' && args[0] === 'get' && args[1] === 'metadata') {
			const key = `${args[args.indexOf('--namespace') + 1]}/${args[2]}`;
			if (key === failMetadataOf) throw Object.assign(new Error('exit 1'), { stderr: 'Error: release: not found' });
			return JSON.stringify(METADATA[key]);
		}
		if (command === 'kubectl') return JSON.stringify(NAMESPACES);
		throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
	};
	return { run, calls };
}

// ---------------------------------------------------------------- the listing
{
	const { run, calls } = fakeRun();
	const out = scanCluster(SCOPE, run, KUBECONFIG);

	check('the scope is echoed: cluster, region and the request it answers', out.cluster === 'k8simp-cluster' && out.region === 'us-west-2' && out.requestId === 'req-1', JSON.stringify(out).slice(0, 200));
	check('every release is listed', out.releases.length === 4, JSON.stringify(out.releases));

	const eso = out.releases.find((r) => r.name === 'external-secrets');
	check('a release carries its chart name and its version apart', eso?.chart === 'external-secrets' && eso?.version === '2.15.0', JSON.stringify(eso));
	const canary = out.releases.find((r) => r.name === 'canary');
	check(
		'a version with a hyphen comes whole, from the metadata, not split out of the list',
		canary?.chart === 'my-chart' && canary?.version === '1.0.0-rc.1',
		JSON.stringify(canary)
	);
	check('the status of the release comes from the list', canary?.status === 'failed', JSON.stringify(canary));
	const csi = out.releases.find((r) => r.name === 'csi-secrets-store');
	check('a release named apart from its chart keeps both', csi?.chart === 'secrets-store-csi-driver' && csi?.namespace === 'kube-system', JSON.stringify(csi));

	check('every namespace is listed', out.namespaces.length === 3, JSON.stringify(out.namespaces));
	const argocd = out.namespaces.find((n) => n.metadata.name === 'argocd');
	check(
		'a namespace keeps its name, labels and phase, and nothing else',
		JSON.stringify(argocd) ===
			JSON.stringify({ metadata: { name: 'argocd', labels: { 'kubernetes.io/metadata.name': 'argocd', name: 'argocd' } }, status: { phase: 'Active' } }),
		JSON.stringify(argocd)
	);
	const appA = out.namespaces.find((n) => n.metadata.name === 'app-a');
	check('and its annotations', appA?.metadata?.annotations?.['example.com/owner'] === 'platform', JSON.stringify(appA));
	check('no errors on a cluster that answers everything', out.errors.length === 0, JSON.stringify(out.errors));

	check(
		'the kubeconfig is written for the cluster named in the scope',
		calls.some((c) => c.join(' ') === `aws eks update-kubeconfig --name k8simp-cluster --region us-west-2 --kubeconfig ${KUBECONFIG}`),
		JSON.stringify(calls[0])
	);
	check(
		'every helm and kubectl call goes through that kubeconfig',
		calls.filter((c) => c[0] !== 'aws').every((c) => c[c.indexOf('--kubeconfig') + 1] === KUBECONFIG),
		JSON.stringify(calls)
	);
	check(
		'helm list is asked for every namespace and past its default limit of 256',
		calls.some((c) => c[0] === 'helm' && c[1] === 'list' && c.includes('--all-namespaces') && c.includes('--max')),
		JSON.stringify(calls.find((c) => c[1] === 'list'))
	);
	check(
		'nothing asks for the values of a release',
		!calls.some((c) => c[0] === 'helm' && c[1] === 'get' && c[2] !== 'metadata'),
		JSON.stringify(calls.filter((c) => c[1] === 'get'))
	);
	check('and nothing in the listing holds a values field', !/"values"/.test(JSON.stringify(out)), JSON.stringify(out).match(/"values"[^,]*/)?.[0]);
}

// ---------------------------------------------- a release that cannot be read
{
	const { run } = fakeRun({ failMetadataOf: 'argocd/argocd' });
	const out = scanCluster(SCOPE, run, KUBECONFIG);
	check('a release whose metadata cannot be read is left out', !out.releases.some((r) => r.name === 'argocd') && out.releases.length === 3, JSON.stringify(out.releases.map((r) => r.name)));
	check(
		'and named in errors, with the reason',
		out.errors.length === 1 && out.errors[0].source === 'release argocd/argocd' && /not found/.test(out.errors[0].message),
		JSON.stringify(out.errors)
	);
}

// ------------------------------------------------ a cluster that cannot be read
{
	const { run } = fakeRun({ failList: 'Error: Kubernetes cluster unreachable: the server has asked for the client to provide credentials' });
	let error = null;
	try {
		scanCluster(SCOPE, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a list that cannot be read ends the scan, instead of an empty listing', error !== null, 'no error thrown');
	check('and the message names the access entry when the server refused the caller', /access entry/.test(error?.message ?? ''), error?.message);
}
{
	const { run } = fakeRun({ failKubeconfig: 'An error occurred (ResourceNotFoundException) when calling the DescribeCluster operation: No cluster found for name: nope.' });
	let error = null;
	try {
		scanCluster({ ...SCOPE, cluster: 'nope' }, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a cluster that does not exist ends the scan and says which', /Could not reach the EKS cluster 'nope' in us-west-2/.test(error?.message ?? ''), error?.message);
	check('without blaming an access entry', !/access entry/.test(error?.message ?? ''), error?.message);
}
{
	let error = null;
	try {
		scanCluster({ region: 'us-west-2' }, fakeRun().run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a scope with no cluster name ends the scan before calling anything', /No cluster name/.test(error?.message ?? ''), error?.message);
}

// ------------------------------------------------------------------ the scope
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cluster-scope-'));
	const file = path.join(dir, 'cluster_scope.json');
	fs.writeFileSync(file, JSON.stringify(SCOPE));
	const fromFile = readScope([], file);
	check('the scope comes from cluster_scope.json', JSON.stringify(fromFile) === JSON.stringify(SCOPE), JSON.stringify(fromFile));
	const fromFlags = readScope(['--cluster', 'other', '--region', 'eu-west-1'], file);
	check('and the flags override it', fromFlags.cluster === 'other' && fromFlags.region === 'eu-west-1' && fromFlags.requestId === 'req-1', JSON.stringify(fromFlags));
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
