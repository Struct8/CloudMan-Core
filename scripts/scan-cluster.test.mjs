// Exercises scan-cluster.mjs without a cluster.
//
// HOW. The script exports `scanCluster(scope, run, kubeconfig)`, and `run` is the one
// door to the outside world (`aws`, `helm`, `kubectl`). The test hands it a table of
// canned answers, shaped as those three commands answer, and records every call.
//
// WHAT IT DOES NOT COVER. That the real commands accept these flags and answer with
// these field names. The answers below were taken from the k8simp labs (12/11/2026
// and 14/11/2026, helm 3, EKS 1.37) and cut down; only a run against a cluster
// settles the rest.
//
// No dependencies and no runner, like scan-account.test.mjs.
//
// Usage:
//   node scripts/scan-cluster.test.mjs

import { INVENTORY_VERSION, PLATFORMS, objectOf, readScope, scanCluster } from './scan-cluster.mjs';
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
const SCOPE = { platform: 'eks', cluster: 'k8simp-cluster', region: 'us-west-2', requestId: 'req-1' };

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
		// Argo CD creates a namespace with CreateNamespace=true through an apply, which
		// leaves the annotation below on it.
		{ metadata: { name: 'app-b', uid: 'u4', labels: { 'kubernetes.io/metadata.name': 'app-b' }, annotations: { 'kubectl.kubernetes.io/last-applied-configuration': '{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"app-b"}}' } }, status: { phase: 'Active' } },
		{ metadata: { name: 'kube-system', uid: 'u3' }, status: { phase: 'Active' } }
	]
};

// ------------------------------------------------------------ phase 4: objects
//
// The values a Secret and an Application hold. None of them may reach the listing,
// in any form: as written, as base64, or inside the annotation `kubectl apply`
// leaves on the object.
const SECRET_VALUE = 'lab-only-not-a-secret';
const APP_VALUE = 'lab-only-app-value';
const b64 = (text) => Buffer.from(text).toString('base64');
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

// `kubectl get --raw /api/v1` and `/apis/<group>/<version>`, cut to what the
// discovery is asked for.
const DISCOVERY = {
	'/api/v1': [
		{ name: 'bindings', namespaced: true, kind: 'Binding', verbs: ['create'] },
		{ name: 'configmaps', singularName: 'configmap', namespaced: true, kind: 'ConfigMap', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
		{ name: 'namespaces', singularName: 'namespace', namespaced: false, kind: 'Namespace', verbs: ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch'] },
		{ name: 'persistentvolumeclaims', singularName: 'persistentvolumeclaim', namespaced: true, kind: 'PersistentVolumeClaim', verbs: ['get', 'list'] },
		{ name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['get', 'list'] },
		{ name: 'pods/log', singularName: '', namespaced: true, kind: 'Pod', verbs: ['get'] },
		{ name: 'secrets', singularName: 'secret', namespaced: true, kind: 'Secret', verbs: ['get', 'list'] },
		{ name: 'services', singularName: 'service', namespaced: true, kind: 'Service', verbs: ['get', 'list'] }
	],
	'/apis/apps/v1': [
		{ name: 'deployments', singularName: 'deployment', namespaced: true, kind: 'Deployment', verbs: ['get', 'list'] },
		{ name: 'deployments/scale', singularName: '', namespaced: true, group: 'autoscaling', version: 'v1', kind: 'Scale', verbs: ['get', 'patch', 'update'] },
		{ name: 'statefulsets', singularName: 'statefulset', namespaced: true, kind: 'StatefulSet', verbs: ['get', 'list'] }
	],
	'/apis/autoscaling/v2': [
		{ name: 'horizontalpodautoscalers', singularName: 'horizontalpodautoscaler', namespaced: true, kind: 'HorizontalPodAutoscaler', verbs: ['get', 'list'] }
	],
	'/apis/storage.k8s.io/v1': [
		{ name: 'storageclasses', singularName: 'storageclass', namespaced: false, kind: 'StorageClass', verbs: ['get', 'list'] }
	],
	'/apis/argoproj.io/v1alpha1': [
		{ name: 'applications', singularName: 'application', namespaced: true, kind: 'Application', verbs: ['get', 'list'] },
		{ name: 'appprojects', singularName: 'appproject', namespaced: true, kind: 'AppProject', verbs: ['get', 'list'] }
	]
};

// `kubectl get <resource> [--namespace <ns> | --all-namespaces] -o json`, per
// resource as named on the command line, then per namespace ('' = cluster-wide,
// '*' = every namespace).
const OBJECTS = {
	'deployments.v1.apps': {
		'app-a': [
			{
				apiVersion: 'apps/v1',
				kind: 'Deployment',
				metadata: {
					name: 'web',
					namespace: 'app-a',
					uid: 'd-1',
					resourceVersion: '2201',
					generation: 3,
					creationTimestamp: '2026-11-14T10:00:00Z',
					labels: { app: 'web' },
					annotations: {
						'deployment.kubernetes.io/revision': '1',
						[LAST_APPLIED]: '{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"web"}}'
					},
					managedFields: [{ manager: 'kubectl-client-side-apply', operation: 'Update' }]
				},
				spec: { replicas: 2, selector: { matchLabels: { app: 'web' } }, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx:1.27-alpine', env: [{ name: 'GREETING', value: 'hello' }] }] } } },
				status: { replicas: 2, readyReplicas: 2, observedGeneration: 3 }
			}
		],
		'app-b': [
			{
				apiVersion: 'apps/v1',
				kind: 'Deployment',
				metadata: { name: 'podinfo', namespace: 'app-b', uid: 'd-2', labels: { 'app.kubernetes.io/managed-by': 'Helm' }, annotations: { 'meta.helm.sh/release-name': 'podinfo', 'meta.helm.sh/release-namespace': 'app-b' } },
				spec: { replicas: 1, selector: { matchLabels: { 'app.kubernetes.io/name': 'podinfo' } } },
				status: { replicas: 1 }
			}
		]
	},
	secrets: {
		'app-a': [
			{
				apiVersion: 'v1',
				kind: 'Secret',
				metadata: {
					name: 'web-secret',
					namespace: 'app-a',
					uid: 's-1',
					annotations: {
						[LAST_APPLIED]: `{"apiVersion":"v1","kind":"Secret","metadata":{"name":"web-secret","namespace":"app-a"},"stringData":{"DB_PASSWORD":"${SECRET_VALUE}","DB_USER":"app"},"type":"Opaque"}`
					}
				},
				type: 'Opaque',
				data: { DB_USER: b64('app'), DB_PASSWORD: b64(SECRET_VALUE) }
			}
		],
		'app-b': [
			{
				apiVersion: 'v1',
				kind: 'Secret',
				metadata: { name: 'sh.helm.release.v1.podinfo.v1', namespace: 'app-b', labels: { name: 'podinfo', owner: 'helm', status: 'deployed', version: '1' } },
				type: 'helm.sh/release.v1',
				data: { release: b64(`H4sIAAAA${APP_VALUE}`) }
			}
		]
	},
	pods: {
		'app-a': [
			{
				apiVersion: 'v1',
				kind: 'Pod',
				metadata: {
					name: 'web-5d8f-x1',
					namespace: 'app-a',
					labels: { app: 'web' },
					ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-5d8f', uid: 'rs-1', controller: true, blockOwnerDeletion: true }]
				},
				spec: { containers: [{ name: 'web', image: 'nginx:1.27-alpine' }] },
				status: { phase: 'Running' }
			}
		]
	},
	'storageclasses.v1.storage.k8s.io': {
		'': [
			{ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'gp2', uid: 'sc-1', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'kubernetes.io/aws-ebs', reclaimPolicy: 'Delete' }
		]
	},
	'applications.v1alpha1.argoproj.io': {
		'*': [
			{
				apiVersion: 'argoproj.io/v1alpha1',
				kind: 'Application',
				metadata: { name: 'guestbook', namespace: 'argocd', uid: 'a-1', annotations: { [LAST_APPLIED]: `{"spec":{"source":{"helm":{"values":"password: ${APP_VALUE}"}}}}` } },
				spec: {
					project: 'default',
					destination: { server: 'https://kubernetes.default.svc', namespace: 'app-c' },
					source: {
						repoURL: 'https://github.com/argoproj/argocd-example-apps',
						path: 'helm-guestbook',
						targetRevision: 'HEAD',
						helm: { values: `password: ${APP_VALUE}`, valuesObject: { password: APP_VALUE }, parameters: [{ name: 'password', value: APP_VALUE }] }
					},
					syncPolicy: { automated: { prune: true }, syncOptions: ['CreateNamespace=true'] }
				},
				status: {
					sync: { status: 'Synced', revision: 'abc' },
					health: { status: 'Healthy' },
					resources: [
						{ version: 'v1', kind: 'Service', namespace: 'app-c', name: 'guestbook-ui', status: 'Synced', health: { status: 'Healthy' } },
						{ group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'app-c', name: 'guestbook-ui', status: 'Synced' }
					],
					history: [{ revision: 'abc', source: { helm: { values: `password: ${APP_VALUE}` } } }]
				}
			}
		]
	}
};

const KINDS = [
	{ apiVersion: 'apps/v1', kind: 'Deployment' },
	{ apiVersion: 'v1', kind: 'Secret' },
	{ apiVersion: 'v1', kind: 'Pod' },
	{ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass' },
	// Served by no cluster without the Prometheus operator.
	{ apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor' },
	// A group the cluster serves, without this kind in it.
	{ apiVersion: 'apps/v1', kind: 'DaemonSetThatDoesNotExist' },
	{ apiVersion: 'v1', kind: 'Secret' }
];

function fakeRun({ failMetadataOf = null, failList = null, failKubeconfig = null, failGet = null, failDiscovery = null } = {}) {
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
		if (command === 'kubectl' && args[0] === 'get' && args[1] === '--raw') {
			const where = args[2];
			if (where === failDiscovery) {
				throw Object.assign(new Error('exit 1'), { stderr: 'Error from server (ServiceUnavailable): the server is currently unable to handle the request' });
			}
			if (!DISCOVERY[where]) throw Object.assign(new Error('exit 1'), { stderr: 'Error from server (NotFound): the server could not find the requested resource' });
			return JSON.stringify({ kind: 'APIResourceList', groupVersion: where.replace(/^\/apis?\//, ''), resources: DISCOVERY[where] });
		}
		if (command === 'kubectl' && args[0] === 'get' && args[1] === 'namespaces' && !args.includes('--namespace')) {
			return JSON.stringify(NAMESPACES);
		}
		if (command === 'kubectl' && args[0] === 'get') {
			const resource = args[1];
			const ns = args.includes('--all-namespaces') ? '*' : args.includes('--namespace') ? args[args.indexOf('--namespace') + 1] : '';
			if (failGet === `${resource} ${ns}`) {
				throw Object.assign(new Error('exit 1'), { stderr: `Error from server (Forbidden): ${resource} is forbidden: User "lab" cannot list resource "${resource}" in the namespace "${ns}"` });
			}
			return JSON.stringify({ apiVersion: 'v1', kind: 'List', items: OBJECTS[resource]?.[ns] ?? [] });
		}
		throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
	};
	return { run, calls };
}

// ---------------------------------------------------------------- the listing
{
	const { run, calls } = fakeRun();
	const out = scanCluster(SCOPE, run, KUBECONFIG);

	check('the listing says which version of the file it is', out.version === INVENTORY_VERSION && INVENTORY_VERSION === 2, String(out.version));
	check('the scope is echoed: platform, cluster, region and the request it answers', out.platform === 'eks' && out.cluster === 'k8simp-cluster' && out.region === 'us-west-2' && out.requestId === 'req-1', JSON.stringify(out).slice(0, 200));
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

	check('every namespace is listed', out.namespaces.length === 4, JSON.stringify(out.namespaces));
	const argocd = out.namespaces.find((n) => n.metadata.name === 'argocd');
	check(
		'a namespace keeps its name, labels and phase, and nothing else',
		JSON.stringify(argocd) ===
			JSON.stringify({ metadata: { name: 'argocd', labels: { 'kubernetes.io/metadata.name': 'argocd', name: 'argocd' } }, status: { phase: 'Active' } }),
		JSON.stringify(argocd)
	);
	const appA = out.namespaces.find((n) => n.metadata.name === 'app-a');
	check('and its annotations', appA?.metadata?.annotations?.['example.com/owner'] === 'platform', JSON.stringify(appA));
	const appB = out.namespaces.find((n) => n.metadata.name === 'app-b');
	check(
		'but not the annotation kubectl apply leaves, which is all app-b has',
		JSON.stringify(appB) === JSON.stringify({ metadata: { name: 'app-b', labels: { 'kubernetes.io/metadata.name': 'app-b' } }, status: { phase: 'Active' } }),
		JSON.stringify(appB)
	);
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

	check(
		'without chosen namespaces, no object is asked for and the listing has no objects, as in phase 3',
		!calls.some((c) => c[0] === 'kubectl' && c[2] !== 'namespaces') && !('objects' in out) && !('kinds' in out) && !('applications' in out),
		JSON.stringify(calls.filter((c) => c[0] === 'kubectl'))
	);
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
		scanCluster({ platform: 'eks', region: 'us-west-2' }, fakeRun().run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a scope with no cluster name ends the scan before calling anything', /No cluster name/.test(error?.message ?? ''), error?.message);
}

// --------------------------------------------------------------- the platform
{
	const { run, calls } = fakeRun();
	let error = null;
	try {
		scanCluster({ cluster: 'k8simp-cluster', region: 'us-west-2' }, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a scope that names no platform is not taken for an EKS cluster', /No platform/.test(error?.message ?? '') && calls.length === 0, `${error?.message} / ${calls.length} call(s)`);
}
{
	const { run, calls } = fakeRun();
	let error = null;
	try {
		scanCluster({ ...SCOPE, platform: 'k3s' }, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check(
		'a platform this engine does not know ends the scan before calling anything, and names the ones it knows',
		/Unknown platform 'k3s': this engine reaches eks./.test(error?.message ?? '') && calls.length === 0,
		`${error?.message} / ${calls.length} call(s)`
	);
}
{
	let error = null;
	try {
		scanCluster({ ...SCOPE, platform: 'toString' }, fakeRun().run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a name inherited by every object is not a platform', /Unknown platform 'toString'/.test(error?.message ?? ''), error?.message);
}
check(
	'every platform says how to write its kubeconfig and what to do on a refusal',
	Object.values(PLATFORMS).every((p) => typeof p.kubeconfig === 'function' && p.label && p.noAccess),
	Object.keys(PLATFORMS).join(', ')
);

// ------------------------------------------------- the objects of the namespaces
{
	const { run, calls } = fakeRun();
	const out = scanCluster({ ...SCOPE, namespaces: ['app-a', 'app-b'], kinds: KINDS }, run, KUBECONFIG);
	const text = JSON.stringify(out);
	const gets = calls.filter((c) => c[0] === 'kubectl' && c[1] === 'get' && c[2] !== '--raw' && c[2] !== 'namespaces');
	const objectsOf = (kind) => out.objects.filter((o) => o.kind === kind);

	check('the releases and the namespaces are still listed', out.releases.length === 4 && out.namespaces.length === 4, `${out.releases.length} / ${out.namespaces.length}`);
	check('no errors on a cluster that answers everything', out.errors.length === 0, JSON.stringify(out.errors));

	const web = objectsOf('Deployment').find((o) => o.metadata.name === 'web');
	check('an object of each chosen namespace is listed', objectsOf('Deployment').map((o) => o.metadata.namespace).sort().join() === 'app-a,app-b', JSON.stringify(objectsOf('Deployment').map((o) => o.metadata)));
	check('an object carries its apiVersion, its kind and its spec', web?.apiVersion === 'apps/v1' && web?.kind === 'Deployment' && web?.spec?.selector?.matchLabels?.app === 'web', JSON.stringify(web)?.slice(0, 200));
	check(
		'its metadata keeps the name, the namespace, the labels and the annotations a person writes',
		JSON.stringify(web?.metadata) === JSON.stringify({ name: 'web', namespace: 'app-a', labels: { app: 'web' }, annotations: { 'deployment.kubernetes.io/revision': '1' } }),
		JSON.stringify(web?.metadata)
	);
	check('no object keeps its status', !out.objects.some((o) => 'status' in o && o.kind !== 'Application'), JSON.stringify(out.objects.find((o) => 'status' in o))?.slice(0, 200));
	check(
		"nor the server's bookkeeping: uid, resourceVersion, generation, timestamps, managedFields",
		!/"uid"|"resourceVersion"|"generation"|"creationTimestamp"|"managedFields"/.test(JSON.stringify(out.objects)),
		JSON.stringify(out.objects).match(/.{30}("uid"|"resourceVersion"|"generation"|"creationTimestamp"|"managedFields").{30}/)?.[0]
	);
	check('nor the annotation kubectl apply leaves, on any object', !text.includes(LAST_APPLIED), text.match(/.{40}last-applied.{40}/)?.[0]);
	const podinfo = objectsOf('Deployment').find((o) => o.metadata.name === 'podinfo');
	check('the annotations of the Helm release that owns an object are kept', podinfo?.metadata?.annotations?.['meta.helm.sh/release-name'] === 'podinfo', JSON.stringify(podinfo?.metadata));
	const pod = objectsOf('Pod')[0];
	check(
		'an owner reference keeps the owner and whether it controls, not its uid',
		JSON.stringify(pod?.metadata?.ownerReferences) === JSON.stringify([{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'web-5d8f', controller: true }]),
		JSON.stringify(pod?.metadata?.ownerReferences)
	);

	const secret = objectsOf('Secret').find((o) => o.metadata.name === 'web-secret');
	check(
		'a Secret keeps its name, its type and the names of its keys, and nothing else',
		JSON.stringify(secret) === JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'web-secret', namespace: 'app-a' }, type: 'Opaque', keys: ['DB_PASSWORD', 'DB_USER'] }),
		JSON.stringify(secret)
	);
	check(
		'no value of a Secret reaches the listing: not as written, not in base64',
		!text.includes(SECRET_VALUE) && !text.includes(b64(SECRET_VALUE)) && !text.includes(b64('app')) && !/"data"|"stringData"/.test(text),
		text.match(/.{40}(lab-only|"data"|"stringData").{40}/)?.[0]
	);
	const helmRelease = objectsOf('Secret').find((o) => o.metadata.name.startsWith('sh.helm.release'));
	check('the Secret that holds a Helm release keeps only its key name', JSON.stringify(helmRelease?.keys) === '["release"]' && helmRelease?.type === 'helm.sh/release.v1', JSON.stringify(helmRelease));
	check(
		'Secrets are read only in the chosen namespaces, never from every namespace',
		gets.filter((c) => c[2] === 'secrets').every((c) => c.includes('--namespace') && !c.includes('--all-namespaces')) &&
			gets.filter((c) => c[2] === 'secrets').map((c) => c[c.indexOf('--namespace') + 1]).join() === 'app-a,app-b',
		JSON.stringify(gets.filter((c) => c[2] === 'secrets'))
	);

	const answer = (kind) => out.kinds.find((k) => k.kind === kind);
	check(
		'each kind asked for is answered once, with whether the cluster serves it',
		answer('Deployment')?.served === true && answer('Deployment')?.namespaced === true && out.kinds.filter((k) => k.kind === 'Secret').length === 1,
		JSON.stringify(out.kinds)
	);
	check(
		'a kind of a group the cluster does not serve is answered as not served, without an error and without a listing call',
		answer('ServiceMonitor')?.served === false && !gets.some((c) => /servicemonitor/i.test(c[2])),
		JSON.stringify(answer('ServiceMonitor'))
	);
	check('so is a kind missing from a group the cluster serves', answer('DaemonSetThatDoesNotExist')?.served === false, JSON.stringify(answer('DaemonSetThatDoesNotExist')));
	check(
		'a kind outside namespaces is listed once, whole, with no namespace on the call',
		answer('StorageClass')?.namespaced === false &&
			gets.filter((c) => c[2] === 'storageclasses.v1.storage.k8s.io').length === 1 &&
			!gets.find((c) => c[2] === 'storageclasses.v1.storage.k8s.io')?.includes('--namespace') &&
			objectsOf('StorageClass').length === 1,
		JSON.stringify(gets.filter((c) => c[2].startsWith('storageclasses')))
	);
	check(
		'a kind outside the core group is named in full on the call, and a core kind by its plural',
		gets.some((c) => c[2] === 'deployments.v1.apps') && gets.some((c) => c[2] === 'secrets'),
		JSON.stringify(gets.map((c) => c[2]))
	);
	check('a subresource and a resource that cannot be listed are not kinds', !gets.some((c) => c[2].includes('/') || c[2] === 'bindings'), JSON.stringify(gets.map((c) => c[2])));

	const app = out.applications?.[0];
	check('the Argo CD Applications are listed from every namespace', out.applications?.length === 1 && gets.some((c) => c[2] === 'applications.v1alpha1.argoproj.io' && c.includes('--all-namespaces')), JSON.stringify(out.applications)?.slice(0, 200));
	check('and answered as a kind, though not asked for', answer('Application')?.served === true, JSON.stringify(out.kinds));
	check(
		'an Application keeps its project, its destination and where its source comes from',
		app?.spec?.project === 'default' && app?.spec?.destination?.namespace === 'app-c' && app?.spec?.source?.repoURL === 'https://github.com/argoproj/argocd-example-apps' && app?.spec?.source?.path === 'helm-guestbook',
		JSON.stringify(app?.spec)
	);
	check(
		'and the objects it syncs, each by group, kind, namespace and name',
		JSON.stringify(app?.status) ===
			JSON.stringify({ resources: [{ version: 'v1', kind: 'Service', namespace: 'app-c', name: 'guestbook-ui' }, { group: 'apps', version: 'v1', kind: 'Deployment', namespace: 'app-c', name: 'guestbook-ui' }] }),
		JSON.stringify(app?.status)
	);
	check('its sync policy is kept', app?.spec?.syncPolicy?.automated?.prune === true, JSON.stringify(app?.spec?.syncPolicy));
	check(
		'no Helm value or parameter of an Application reaches the listing',
		!text.includes(APP_VALUE) && !/"helm":|"valuesObject":|"parameters":|"history":/.test(text),
		text.match(/.{40}(lab-only-app|"helm":|"valuesObject":|"parameters":|"history":).{40}/)?.[0]
	);
}

// ------------------------------------------------ objects: what can go wrong
{
	const { run, calls } = fakeRun({ failGet: 'secrets app-b' });
	const out = scanCluster({ ...SCOPE, namespaces: ['app-a', 'app-b', 'gone'], kinds: KINDS }, run, KUBECONFIG);
	check(
		'a kind that cannot be read in one namespace is named in errors, and the rest is listed',
		out.errors.some((e) => e.source === 'Secret in app-b' && /forbidden/i.test(e.message)) && out.objects.some((o) => o.kind === 'Secret' && o.metadata.namespace === 'app-a'),
		JSON.stringify(out.errors)
	);
	check(
		'a chosen namespace the cluster does not have is named in errors, and nothing is asked in it',
		out.errors.some((e) => e.source === 'namespace gone') && !calls.some((c) => c.includes('gone')),
		JSON.stringify(out.errors)
	);
}
{
	const { run } = fakeRun({ failDiscovery: '/apis/apps/v1' });
	const out = scanCluster({ ...SCOPE, namespaces: ['app-a'], kinds: KINDS }, run, KUBECONFIG);
	const deployment = out.kinds.find((k) => k.kind === 'Deployment');
	check(
		'an API whose discovery does not answer is named in errors, and its kinds are answered as unknown, not as not served',
		deployment?.served === null && out.errors.some((e) => e.source === 'API apps/v1' && /ServiceUnavailable/.test(e.message)) && !out.objects.some((o) => o.kind === 'Deployment'),
		`${JSON.stringify(deployment)} ${JSON.stringify(out.errors)}`
	);
	check('the other kinds are still listed', out.objects.some((o) => o.kind === 'Secret'), JSON.stringify(out.objects.map((o) => o.kind)));
}
{
	const { run, calls } = fakeRun();
	let error = null;
	try {
		scanCluster({ ...SCOPE, namespaces: ['app-a'] }, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('a scope that chooses namespaces and names no kind is refused before calling anything', /names no kind/.test(error?.message ?? '') && calls.length === 0, `${error?.message} / ${calls.length} call(s)`);
}
{
	const { run, calls } = fakeRun();
	let error = null;
	try {
		scanCluster({ ...SCOPE, namespaces: 'app-a', kinds: KINDS }, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('so is a scope whose namespaces are not a list of names', /not a list of namespace names/.test(error?.message ?? '') && calls.length === 0, `${error?.message} / ${calls.length} call(s)`);
}
{
	const { run, calls } = fakeRun();
	let error = null;
	try {
		scanCluster({ ...SCOPE, namespaces: ['app-a'], kinds: [{ kind: 'Deployment' }] }, run, KUBECONFIG);
	} catch (e) {
		error = e;
	}
	check('and a kind with no apiVersion', /not \{ apiVersion, kind \}/.test(error?.message ?? '') && calls.length === 0, `${error?.message} / ${calls.length} call(s)`);
}
{
	const lean = objectOf({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'empty', namespace: 'app-a', labels: {}, annotations: { [LAST_APPLIED]: '{}' } }, data: { a: '1' } });
	check(
		'empty labels, and annotations left empty without the kubectl one, are not written',
		JSON.stringify(lean) === JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'empty', namespace: 'app-a' }, data: { a: '1' } }),
		JSON.stringify(lean)
	);
}

// ------------------------------------------------------------------ the scope
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-cluster-scope-'));
	const file = path.join(dir, 'cluster_scope.json');
	fs.writeFileSync(file, JSON.stringify(SCOPE));
	const fromFile = readScope([], file);
	check(
		'the scope comes from cluster_scope.json, with no namespace chosen when it chooses none',
		JSON.stringify(fromFile) === JSON.stringify({ ...SCOPE, namespaces: [], kinds: [] }),
		JSON.stringify(fromFile)
	);
	const fromFlags = readScope(['--platform', 'other-platform', '--cluster', 'other', '--region', 'eu-west-1'], file);
	check('and the flags override it', fromFlags.platform === 'other-platform' && fromFlags.cluster === 'other' && fromFlags.region === 'eu-west-1' && fromFlags.requestId === 'req-1', JSON.stringify(fromFlags));

	fs.writeFileSync(file, JSON.stringify({ ...SCOPE, namespaces: ['app-a', 'app-b'], kinds: KINDS.slice(0, 2) }));
	const chosen = readScope([], file);
	check('the namespaces and the kinds come from the file', JSON.stringify(chosen.namespaces) === '["app-a","app-b"]' && chosen.kinds.length === 2, JSON.stringify(chosen));
	const byFlag = readScope(['--namespaces', 'app-c, app-d'], file);
	check('and --namespaces overrides the namespaces', JSON.stringify(byFlag.namespaces) === '["app-c","app-d"]' && byFlag.kinds.length === 2, JSON.stringify(byFlag));
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
