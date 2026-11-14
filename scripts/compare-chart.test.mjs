// Exercises compare-chart.mjs without a cluster.
//
// HOW. The script exports `compareChart(scope, run, kubeconfig, workDir)`, and `run`
// is the one door to the outside world (`aws`, `kubectl`). The test hands it a fake
// cluster: for each object, what `kubectl get` answers and what
// `kubectl apply --dry-run=server` answers, shaped as kubectl answers with
// `--output json`. Every call is recorded.
//
// WHAT IT DOES NOT COVER. That the API server merges a manifest the way these canned
// answers say. The shapes were taken from the k8simp labs (EKS 1.37); the k8simp7
// lab (14/11/2026) ran the script against a real cluster.
//
// No dependencies and no runner, like scan-cluster.test.mjs.
//
// Usage:
//   node scripts/compare-chart.test.mjs

import {
	COMPARISON_VERSION,
	VALUE_MAX,
	comparable,
	compareChart,
	differences,
	documentsOf,
	identityOf,
	readScope,
	summaryOf
} from './compare-chart.mjs';
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

const KUBECONFIG = '/tmp/struct8-compare-test/kubeconfig';
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
const TRACKING = 'argocd.argoproj.io/tracking-id';
const SECRET_VALUE = 'bGFiLXBhc3N3b3Jk';
const NEW_SECRET_VALUE = 'bmV3LXBhc3N3b3Jk';
const REFUSED_SECRET_VALUE = 'aHVudGVyMg==';

/** An error as execFileSync throws it: kubectl's text is on stderr. */
const failed = (stderr) => Object.assign(new Error('Command failed'), { stderr });

/** What the server adds to every object it keeps. */
const kept = (metadata, extra = {}) => ({
	...metadata,
	uid: `uid-${metadata.name}`,
	resourceVersion: '1234',
	generation: 3,
	creationTimestamp: '2026-11-14T12:00:00Z',
	managedFields: [{ manager: 'kubectl-client-side-apply', operation: 'Update' }],
	...extra
});

// ------------------------------------------------------------------ the manifests
// As the generator writes them: one file per object under templates/, a header
// comment, and the objects without a namespace (the Application gives it).
const MANIFESTS = {
	'configmap-web-config.yaml': [
		'# File: templates/configmap-web-config.yaml',
		'apiVersion: v1',
		'kind: ConfigMap',
		'metadata:',
		'  name: web-config',
		'data:',
		'  LOG_LEVEL: info',
		''
	].join('\n'),
	'deployment-web.yaml': [
		'apiVersion: apps/v1',
		'kind: Deployment',
		'metadata:',
		'  name: web',
		'  labels:',
		'    app: web',
		'spec:',
		'  selector:',
		'    matchLabels:',
		'      app: web',
		'  template:',
		'    metadata:',
		'      labels:',
		'        app: web',
		'    spec:',
		'      containers:',
		'        - name: web',
		'          image: nginx:1.27',
		''
	].join('\n'),
	// Two objects in one file, the second with a namespace of its own and a
	// comment-only document at the end.
	'service-web.yaml': [
		'apiVersion: v1',
		'kind: Service',
		'metadata:',
		'  name: web',
		'spec:',
		'  ports:',
		'    - name: http',
		'      port: 80',
		'---',
		'apiVersion: v1',
		'kind: Service',
		'metadata:',
		'  name: "metrics"',
		'  namespace: monitoring',
		'spec:',
		'  ports:',
		'    - name: metrics',
		'      port: 9090',
		'---',
		'# nothing below this line',
		''
	].join('\n'),
	'secret-web-secret.yaml': [
		'apiVersion: v1',
		'kind: Secret',
		'metadata:',
		'  name: web-secret',
		'type: Opaque',
		'data:',
		`  password: ${NEW_SECRET_VALUE}`,
		''
	].join('\n'),
	'secret-db-secret.yaml': [
		'apiVersion: v1',
		'kind: Secret',
		'metadata:',
		'  name: db-secret',
		'type: kubernetes.io/tls',
		'data:',
		`  password: ${REFUSED_SECRET_VALUE}`,
		''
	].join('\n'),
	'horizontalpodautoscaler-web.yaml': [
		'apiVersion: autoscaling/v2',
		'kind: HorizontalPodAutoscaler',
		'metadata:',
		'  name: web',
		'spec:',
		'  minReplicas: 2',
		'  maxReplicas: 5',
		''
	].join('\n'),
	'servicemonitor-web.yaml': [
		'apiVersion: monitoring.coreos.com/v1',
		'kind: ServiceMonitor',
		'metadata:',
		'  name: web',
		'spec: {}',
		''
	].join('\n'),
	'persistentvolumeclaim-data.yaml': [
		'apiVersion: v1',
		'kind: PersistentVolumeClaim',
		'metadata:',
		'  name: data',
		'spec:',
		'  storageClassName: gp2',
		''
	].join('\n'),
	'role-reader.yaml': ['apiVersion: rbac.authorization.k8s.io/v1', 'kind: Role', 'metadata:', '  name: reader', 'rules: []', ''].join('\n'),
	'storageclass-lab-gp3.yaml': [
		'apiVersion: storage.k8s.io/v1',
		'kind: StorageClass',
		'metadata:',
		'  name: lab-gp3',
		'provisioner: ebs.csi.aws.com',
		''
	].join('\n'),
	'configmap-big.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: big', 'data:', `  page: ${'b'.repeat(500)}`, ''].join('\n')
};

// ------------------------------------------------------------------ the cluster
// Keyed by kind/namespace/name, as the fake reads them from the file and the flag.
const webTemplate = (image, annotations) => ({
	metadata: { labels: { app: 'web' }, ...(annotations ? { annotations } : {}) },
	spec: {
		containers: [
			{ name: 'web', image, resources: { limits: { cpu: '500m' } } },
			{ name: 'sidecar', image: 'busybox' }
		],
		restartPolicy: 'Always'
	}
});

const LIVE = {
	'ConfigMap/app-a/web-config': {
		apiVersion: 'v1',
		kind: 'ConfigMap',
		metadata: kept({ name: 'web-config', namespace: 'app-a', annotations: { [LAST_APPLIED]: '{"data":{"LOG_LEVEL":"info"}}', [TRACKING]: 'env:/ConfigMap:app-a/web-config' } }),
		data: { LOG_LEVEL: 'info' }
	},
	'Deployment/app-a/web': {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: kept({ name: 'web', namespace: 'app-a', labels: { app: 'web' }, annotations: { 'deployment.kubernetes.io/revision': '4', [LAST_APPLIED]: '{}' } }),
		spec: { replicas: 3, selector: { matchLabels: { app: 'web' } }, template: webTemplate('nginx:1.27', { 'example.com/restarted-at': '2026-11-10' }) },
		status: { replicas: 3, readyReplicas: 3 }
	},
	'Service/app-a/web': {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: kept({ name: 'web', namespace: 'app-a' }),
		spec: { clusterIP: '10.100.0.12', ports: [{ name: 'http', port: 80, protocol: 'TCP' }, { name: 'https', port: 443, protocol: 'TCP' }] }
	},
	'Service/monitoring/metrics': {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: kept({ name: 'metrics', namespace: 'monitoring' }),
		spec: { ports: [{ name: 'metrics', port: 9090 }] }
	},
	'Secret/app-a/web-secret': {
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: kept({ name: 'web-secret', namespace: 'app-a', annotations: { [LAST_APPLIED]: `{"data":{"password":"${SECRET_VALUE}"}}` } }),
		type: 'Opaque',
		data: { password: SECRET_VALUE, token: 'dG9rZW4=' }
	},
	'Secret/app-a/db-secret': {
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: kept({ name: 'db-secret', namespace: 'app-a' }),
		type: 'Opaque',
		data: { password: SECRET_VALUE }
	},
	'PersistentVolumeClaim/app-a/data': {
		apiVersion: 'v1',
		kind: 'PersistentVolumeClaim',
		metadata: kept({ name: 'data', namespace: 'app-a' }),
		spec: { storageClassName: 'lab-gp3' }
	},
	'StorageClass/app-a/lab-gp3': {
		apiVersion: 'storage.k8s.io/v1',
		kind: 'StorageClass',
		metadata: kept({ name: 'lab-gp3' }),
		provisioner: 'ebs.csi.aws.com'
	},
	'ConfigMap/app-a/big': { apiVersion: 'v1', kind: 'ConfigMap', metadata: kept({ name: 'big', namespace: 'app-a' }), data: { page: 'a'.repeat(500) } }
};

// What the dry run answers: the object as the sync would leave it.
const MERGED = {
	// Same content; the server bumps resourceVersion and rewrites the annotation.
	'ConfigMap/app-a/web-config': {
		...LIVE['ConfigMap/app-a/web-config'],
		metadata: kept({ name: 'web-config', namespace: 'app-a', annotations: { [LAST_APPLIED]: '{"other":"text"}', [TRACKING]: 'env:/ConfigMap:app-a/web-config' } }, { resourceVersion: '1235' })
	},
	// The last-applied annotation named the limits and the restart annotation; the
	// manifest has neither, so the apply removes both, and the sidecar too.
	'Deployment/app-a/web': {
		...LIVE['Deployment/app-a/web'],
		spec: {
			replicas: 3,
			selector: { matchLabels: { app: 'web' } },
			template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ name: 'web', image: 'nginx:1.27' }], restartPolicy: 'Always' } }
		}
	},
	// The https port is removed and a label added; nothing under a pod template.
	'Service/app-a/web': {
		...LIVE['Service/app-a/web'],
		metadata: kept({ name: 'web', namespace: 'app-a', labels: { team: 'web' } }),
		spec: { clusterIP: '10.100.0.12', ports: [{ name: 'http', port: 80, protocol: 'TCP' }] }
	},
	'Service/monitoring/metrics': LIVE['Service/monitoring/metrics'],
	// A new value for the password, and the token key removed.
	'Secret/app-a/web-secret': {
		...LIVE['Secret/app-a/web-secret'],
		metadata: kept({ name: 'web-secret', namespace: 'app-a', annotations: { [LAST_APPLIED]: `{"data":{"password":"${NEW_SECRET_VALUE}"}}` } }),
		data: { password: NEW_SECRET_VALUE }
	},
	'HorizontalPodAutoscaler/app-a/web': {
		apiVersion: 'autoscaling/v2',
		kind: 'HorizontalPodAutoscaler',
		metadata: kept({ name: 'web', namespace: 'app-a' }),
		spec: { minReplicas: 2, maxReplicas: 5 }
	},
	'StorageClass/app-a/lab-gp3': LIVE['StorageClass/app-a/lab-gp3'],
	'ConfigMap/app-a/big': { ...LIVE['ConfigMap/app-a/big'], data: { page: 'b'.repeat(500) } }
};

// What kubectl answers when it does not answer with an object.
const GET_FAILS = {
	'ServiceMonitor/app-a/web':
		'error: resource mapping not found for name: "web" namespace: "app-a" from "{file}": no matches for kind "ServiceMonitor" in version "monitoring.coreos.com/v1"\nensure CRDs are installed first',
	'Role/app-a/reader':
		'Error from server (Forbidden): roles.rbac.authorization.k8s.io "reader" is forbidden: User "arn:aws:sts::000000000000:assumed-role/lab/run" cannot get resource "roles" in API group "rbac.authorization.k8s.io" in the namespace "app-a"'
};
const APPLY_FAILS = {
	'PersistentVolumeClaim/app-a/data':
		'The PersistentVolumeClaim "data" is invalid: spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims',
	// kubectl quotes the manifest in some refusals; this one names the value.
	'Secret/app-a/db-secret': `The Secret "db-secret" is invalid: type: Invalid value: "kubernetes.io/tls": field is immutable (data.password: ${REFUSED_SECRET_VALUE})`
};

function fakeCluster(calls, { reach = true, apiServer = null } = {}) {
	return (command, args) => {
		calls.push([command, ...args]);
		if (command === 'aws') {
			if (!reach) throw failed('An error occurred (ResourceNotFoundException) when calling the DescribeCluster operation: No cluster found for name: k8simp-cluster.');
			return '';
		}
		if (command !== 'kubectl') throw failed(`unexpected command ${command}`);
		if (args[0] === 'version') {
			if (apiServer) throw failed(apiServer);
			return '{"clientVersion":{},"serverVersion":{}}';
		}
		const file = args[args.indexOf('-f') + 1];
		const said = identityOf(fs.readFileSync(file, 'utf-8'));
		const key = `${said.kind}/${args[args.indexOf('--namespace') + 1]}/${said.name}`;
		if (args[0] === 'get') {
			// kubectl names the file it read.
			if (GET_FAILS[key]) throw failed(GET_FAILS[key].replace('{file}', file));
			if (!LIVE[key]) throw failed(`Error from server (NotFound): ${said.kind.toLowerCase()}s "${said.name}" not found`);
			return JSON.stringify(LIVE[key]);
		}
		if (args[0] === 'apply') {
			if (GET_FAILS[key]) throw failed(GET_FAILS[key]);
			if (APPLY_FAILS[key]) throw failed(APPLY_FAILS[key]);
			if (!MERGED[key]) throw failed(`no canned answer for ${key}`);
			return JSON.stringify(MERGED[key]);
		}
		throw failed(`unexpected kubectl ${args[0]}`);
	};
}

function writeManifests(dir) {
	const folder = path.join(dir, 'manifests');
	fs.mkdirSync(path.join(folder, 'templates'), { recursive: true });
	for (const [name, text] of Object.entries(MANIFESTS)) fs.writeFileSync(path.join(folder, 'templates', name), text);
	fs.writeFileSync(path.join(folder, 'templates', 'README.txt'), 'not a manifest');
	return folder;
}

const SCOPE = { platform: 'eks', cluster: 'k8simp-cluster', region: 'us-west-2', requestId: 'req-7', namespace: 'app-a' };

// ------------------------------------------------------------------ one comparison
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-chart-'));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-chart-work-'));
	const folder = writeManifests(dir);
	const calls = [];
	const result = compareChart({ ...SCOPE, manifests: folder }, fakeCluster(calls), KUBECONFIG, work);
	const of = (kind, name) => result.objects.find((o) => o.kind === kind && o.name === name);
	const text = JSON.stringify(result);

	check(
		'the comparison says its version, the cluster, the namespace and the request',
		result.version === COMPARISON_VERSION && result.platform === 'eks' && result.cluster === 'k8simp-cluster' && result.region === 'us-west-2' && result.namespace === 'app-a' && result.requestId === 'req-7',
		JSON.stringify({ ...result, objects: undefined })
	);
	check('one entry per object of the manifests, the comment-only document and the text file left out', result.objects.length === 12, result.objects.map((o) => `${o.kind}/${o.name}`).join(' '));
	check('every entry names the file it came from, from the manifests folder', result.objects.every((o) => o.file?.startsWith('templates/')), JSON.stringify(result.objects.map((o) => o.file)));

	// The kubeconfig first, then the API server, then the objects.
	check('the kubeconfig is written by the platform command', JSON.stringify(calls[0]) === JSON.stringify(['aws', 'eks', 'update-kubeconfig', '--name', 'k8simp-cluster', '--region', 'us-west-2', '--kubeconfig', KUBECONFIG]), JSON.stringify(calls[0]));
	check('the API server is reached before the objects, with a call that needs no permission on any object', calls[1][0] === 'kubectl' && calls[1][1] === 'version', JSON.stringify(calls[1]));
	const applies = calls.filter((c) => c[1] === 'apply');
	check('every apply is a server dry run', applies.length > 0 && applies.every((c) => c.includes('--dry-run=server')), JSON.stringify(applies.find((c) => !c.includes('--dry-run=server'))));
	check(
		'kubectl is only asked to read, dry-run or say its version',
		calls.filter((c) => c[0] === 'kubectl').every((c) => ['get', 'apply', 'version'].includes(c[1])),
		JSON.stringify(calls.filter((c) => c[0] === 'kubectl').map((c) => c[1]))
	);
	check('every kubectl call uses the kubeconfig the run wrote', calls.filter((c) => c[0] === 'kubectl').every((c) => c[c.indexOf('--kubeconfig') + 1] === KUBECONFIG));
	check(
		'an object that names its namespace is read there, the others in the environment namespace',
		calls.some((c) => c[1] === 'get' && c[c.indexOf('--namespace') + 1] === 'monitoring') &&
			calls.filter((c) => c[1] === 'get').filter((c) => c[c.indexOf('--namespace') + 1] === 'app-a').length === 11
	);
	check('each document is written to a file of its own and removed', fs.readdirSync(work).length === 0, fs.readdirSync(work).join(' '));

	// same
	const config = of('ConfigMap', 'web-config');
	check(
		'an object the sync leaves alone is the same, though the server rewrote resourceVersion and the last-applied annotation',
		config?.status === 'same' && config.changes === undefined,
		JSON.stringify(config)
	);
	check('the tracking-id annotation of Argo CD is not a difference', config?.status === 'same');
	check('a cluster-scoped object is named without a namespace', of('StorageClass', 'lab-gp3')?.status === 'same' && of('StorageClass', 'lab-gp3').namespace === null, JSON.stringify(of('StorageClass', 'lab-gp3')));
	check('an object in another namespace is named there', of('Service', 'metrics')?.namespace === 'monitoring' && of('Service', 'metrics').status === 'same', JSON.stringify(of('Service', 'metrics')));

	// different, with the pods replaced
	const web = of('Deployment', 'web');
	const paths = (entry) => (entry?.changes ?? []).map((c) => `${c.change} ${c.path}`).sort();
	check(
		'a field the last-applied annotation named and the manifest does not have is removed',
		web?.status === 'different' &&
			JSON.stringify(paths(web)) ===
				JSON.stringify(['removed spec.template.metadata.annotations', 'removed spec.template.spec.containers[name=sidecar]', 'removed spec.template.spec.containers[name=web].resources'].sort()),
		JSON.stringify(paths(web))
	);
	check('a change under the pod template replaces the pods', web?.restartsPods === true);
	check(
		'a removed field keeps its value as before, and no after',
		web?.changes.find((c) => c.path === 'spec.template.spec.containers[name=web].resources')?.before?.limits?.cpu === '500m' &&
			!('after' in web.changes.find((c) => c.path === 'spec.template.spec.containers[name=web].resources')),
		JSON.stringify(web?.changes)
	);
	check('status and the server metadata are not differences', !paths(web).some((p) => /status|resourceVersion|managedFields|uid|generation|creationTimestamp/.test(p)));

	// different, without the pods
	const service = of('Service', 'web');
	check(
		'a list item is matched by its name, and a label added is one entry',
		JSON.stringify(paths(service)) === JSON.stringify(['added metadata.labels', 'removed spec.ports[name=https]'].sort()),
		JSON.stringify(paths(service))
	);
	check('a change outside a pod template does not replace the pods', service?.status === 'different' && service.restartsPods === false);

	// a Secret
	const secret = of('Secret', 'web-secret');
	check(
		'a Secret that differs says which keys change',
		secret?.status === 'different' && JSON.stringify(paths(secret)) === JSON.stringify(['changed data.password', 'removed data.token'].sort()),
		JSON.stringify(secret)
	);
	check('and no value of it', secret?.changes.every((c) => !('before' in c) && !('after' in c)), JSON.stringify(secret?.changes));
	const refusedSecret = of('Secret', 'db-secret');
	check('a refused Secret is refused without kubectl message', refusedSecret?.status === 'refused' && !('message' in refusedSecret), JSON.stringify(refusedSecret));
	check(
		'no value of a Secret, live, manifest or quoted in a refusal, reaches the file',
		![SECRET_VALUE, NEW_SECRET_VALUE, REFUSED_SECRET_VALUE, 'dG9rZW4='].some((v) => text.includes(v))
	);
	check('the last-applied annotation never reaches the file', !text.includes(LAST_APPLIED));

	// absent, refused, not served, unreadable
	const hpa = of('HorizontalPodAutoscaler', 'web');
	check('an object the cluster does not have is absent, named as the server answered', hpa?.status === 'absent' && hpa.namespace === 'app-a' && hpa.apiVersion === 'autoscaling/v2', JSON.stringify(hpa));
	const claim = of('PersistentVolumeClaim', 'data');
	check('an object the API server refuses is refused, with the reason', claim?.status === 'refused' && claim.message.includes('spec is immutable'), JSON.stringify(claim));
	const monitor = of('ServiceMonitor', 'web');
	check('a kind the cluster does not serve is not-served', monitor?.status === 'not-served' && monitor.message.includes('no matches for kind'), JSON.stringify(monitor));
	check(
		'a message names the manifest, not the temporary copy kubectl read',
		monitor?.message?.includes('from "templates/servicemonitor-web.yaml"') && !monitor.message.includes(work),
		JSON.stringify(monitor?.message)
	);
	const role = of('Role', 'reader');
	check('an object the run may not read is unreadable, with the reason', role?.status === 'unreadable' && role.message.includes('Forbidden'), JSON.stringify(role));
	check('and a failure is named by the manifest, in the environment namespace', role?.namespace === 'app-a' && role.file === 'templates/role-reader.yaml', JSON.stringify(role));

	// values cut
	const big = of('ConfigMap', 'big')?.changes?.[0];
	check(
		`a value longer than ${VALUE_MAX} characters is cut`,
		typeof big?.after === 'string' && big.after.length === VALUE_MAX + 1 && big.after.endsWith('…'),
		JSON.stringify(big)?.slice(0, 120)
	);

	check(
		'the summary counts each status',
		summaryOf(result) === '4 different, 3 same, 1 absent, 2 refused, 1 unreadable, 1 not-served',
		summaryOf(result)
	);

	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(work, { recursive: true, force: true });
}

// ------------------------------------------------------------------ what ends the run
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-chart-'));
	const folder = writeManifests(dir);
	const empty = path.join(dir, 'empty');
	fs.mkdirSync(empty);
	const attempt = (scope, options) => {
		try {
			compareChart(scope, fakeCluster([], options), KUBECONFIG, dir);
			return null;
		} catch (error) {
			return error.message;
		}
	};
	check('a scope without a namespace ends the run', /No valid namespace/.test(attempt({ ...SCOPE, namespace: null, manifests: folder }) ?? ''));
	check('a namespace Kubernetes would not accept ends the run', /No valid namespace/.test(attempt({ ...SCOPE, namespace: 'App_A', manifests: folder }) ?? ''));
	check('an unknown platform ends the run', /Unknown platform 'aks'/.test(attempt({ ...SCOPE, platform: 'aks', manifests: folder }) ?? ''));
	check('a folder that does not exist ends the run', /No folder/.test(attempt({ ...SCOPE, manifests: path.join(dir, 'missing') }) ?? ''));
	check('a folder without YAML ends the run', /holds no YAML/.test(attempt({ ...SCOPE, manifests: empty }) ?? ''));
	check('a cluster the platform cannot find ends the run', /Could not reach the EKS cluster 'k8simp-cluster'/.test(attempt({ ...SCOPE, manifests: folder }, { reach: false }) ?? ''));
	const refused = attempt({ ...SCOPE, manifests: folder }, { apiServer: 'error: You must be logged in to the server (Unauthorized)' });
	check('a sign-in the cluster refuses ends the run, saying what to do', /Could not reach the API server/.test(refused ?? '') && /access entry/.test(refused ?? ''), refused);
	fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ the pieces
{
	const docs = documentsOf('# File: templates/a.yaml\r\napiVersion: v1\r\nkind: A\r\n---\r\n# only a comment\r\n---\napiVersion: v1\nkind: B\n');
	check('documents split on ---, with CRLF, and comment-only ones dropped', docs.length === 2 && docs[1].startsWith('apiVersion: v1\nkind: B'), JSON.stringify(docs));
	const block = documentsOf('kind: ConfigMap\ndata:\n  script: |\n    echo a\n    ---\n    echo b\n');
	check('a --- indented inside a value of several lines is not a separator', block.length === 1, JSON.stringify(block));

	const id = identityOf("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  labels:\n    name: other\n  name: 'web'\n  namespace: app-b\nspec:\n  name: nope\n");
	check(
		'the identity is read from the top-level lines and the metadata, not a nested name',
		JSON.stringify(id) === JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', namespace: 'app-b' }),
		JSON.stringify(id)
	);

	const object = { metadata: { name: 'x', uid: 'u', annotations: { [LAST_APPLIED]: '{}' } }, status: { a: 1 }, data: { k: 'v' } };
	const lean = comparable(object);
	check('comparable leaves the server fields out and an annotation map it emptied', JSON.stringify(lean) === JSON.stringify({ metadata: { name: 'x' }, data: { k: 'v' } }), JSON.stringify(lean));
	check('and does not change the object it was given', object.metadata.uid === 'u' && object.status.a === 1 && LAST_APPLIED in object.metadata.annotations);

	const env = (names) => names.map((name) => ({ name, value: name.toLowerCase() }));
	const reordered = differences({ env: env(['A', 'B', 'C']) }, { env: env(['C', 'A', 'B']) });
	check('a list of named items in another order is one reordered entry', reordered.length === 1 && reordered[0].change === 'reordered' && reordered[0].path === 'env', JSON.stringify(reordered));
	const byIndex = differences({ args: ['a', 'b'] }, { args: ['a', 'c'] });
	check('a list without names is compared by position', JSON.stringify(byIndex) === JSON.stringify([{ path: 'args[1]', change: 'changed', before: 'b', after: 'c' }]), JSON.stringify(byIndex));
	const longer = differences({ args: ['a'] }, { args: ['a', 'b'] });
	check('two lists of different length without names are one changed entry', longer.length === 1 && longer[0].path === 'args' && longer[0].change === 'changed', JSON.stringify(longer));
	const odd = differences({ metadata: { labels: { 'app.kubernetes.io/name': 'a' } } }, { metadata: { labels: { 'app.kubernetes.io/name': 'b' } } });
	check('a key that is not a plain name is written in brackets', odd[0]?.path === 'metadata.labels["app.kubernetes.io/name"]', JSON.stringify(odd));
	check('equal values have no differences', differences({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }).length === 0);
}

// ------------------------------------------------------------------ the scope
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-chart-scope-'));
	const file = path.join(dir, 'chart_compare_scope.json');
	fs.writeFileSync(file, JSON.stringify({ ...SCOPE, manifests: 'env/manifests' }));
	const fromFile = readScope([], file);
	check(
		'the scope comes from chart_compare_scope.json',
		JSON.stringify(fromFile) === JSON.stringify({ platform: 'eks', cluster: 'k8simp-cluster', region: 'us-west-2', requestId: 'req-7', namespace: 'app-a', manifests: 'env/manifests' }),
		JSON.stringify(fromFile)
	);
	const fromFlags = readScope(['--namespace', 'app-b', '--manifests', 'other', '--cluster', 'c2'], file);
	check('and the flags override it', fromFlags.namespace === 'app-b' && fromFlags.manifests === 'other' && fromFlags.cluster === 'c2' && fromFlags.region === 'us-west-2', JSON.stringify(fromFlags));
	const none = readScope([], path.join(dir, 'missing.json'));
	check('without the file, the manifests folder is manifests', none.manifests === 'manifests' && none.namespace === null, JSON.stringify(none));
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CASES PASSED' : `\n${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
