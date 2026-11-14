#!/usr/bin/env node
//
// Lists one Kubernetes cluster and writes `cluster_inventory.json`, which Struct8
// turns into the selection of a cluster import. Phases 3 and 4 of the Kubernetes
// import (docs/importacao-kubernetes-fase-3-proposta.md and
// docs/importacao-kubernetes-fase-4-proposta.md in the frontend repository).
//
// WHAT IT LISTS, and nothing else:
//
//   - the Helm releases of every namespace, each with its chart name and its
//     version APART, as `helm get metadata` answers them. `helm list` joins the
//     two into one string (`external-secrets-2.15.0`), and splitting it back is a
//     guess when a version holds a hyphen (`1.0.0-rc.1`);
//   - the namespaces, as the Kubernetes API answers them, cut to `metadata.name`,
//     `labels`, `annotations` and `status.phase`;
//   - when the scope chooses namespaces (phase 4): the objects in them, of the
//     kinds the scope names. The API's own discovery says, per kind, whether the
//     cluster serves it and whether it lives in a namespace. A kind that lives
//     outside namespaces (a StorageClass) is listed once, whole;
//   - and with them, the Argo CD Applications of every namespace, with the objects
//     each one syncs: Struct8 leaves out an object another Application already
//     owns (decision 6 of the phase 4 proposal).
//
// An object keeps its `apiVersion` and `kind`, the `metadata` fields a person
// writes (name, namespace, labels, annotations, and the owner references without
// their uid), and every other top-level field but `status`. What the server keeps
// for itself (uid, resourceVersion, managedFields, timestamps) is not part of what
// an import draws.
//
// WHAT IT NEVER WRITES, because this file is committed to the customer's
// repository and each of these can hold a password:
//
//   - the values of a release. `helm get metadata` does not answer them, and
//     nothing here asks for them;
//   - the content of a Secret. A Secret keeps its name, its type and the names of
//     its keys (`keys`), never `data` or `stringData`;
//   - the Helm values and parameters of an Application's source. An Application
//     keeps its project, its destination, where each source comes from, its sync
//     policy and the objects it syncs (`status.resources`);
//   - the annotation `kubectl.kubernetes.io/last-applied-configuration`, on any
//     object, a namespace included. `kubectl apply` writes into it the whole
//     manifest it applied, the values of a Secret in clear text included.
//
// WHAT THIS SCRIPT DOES NOT KNOW: any Struct8 type name, or which charts or kinds
// Struct8 can draw. Struct8 decides that from its catalog and sends the kinds in
// the scope; a type added there changes nothing in this file. The two kinds named
// here, Secret and Application, are named for what they must not leak.
//
// CREDENTIALS. Whatever the caller set up: pipeline.sh runs this after PASSO 2,
// signed in to the cloud of the target, as for the account scan. The cluster is
// reached through a kubeconfig written in a temporary file by the command of its
// PLATFORM (`PLATFORMS` below), whose user takes a token under that same sign-in.
// On EKS that is `aws eks update-kubeconfig` with `AWS_PROFILE=target`, and the
// role needs an access entry on the cluster, or every call answers Unauthorized.
//
// Only the kubeconfig and the advice on a refusal depend on the platform: what is
// listed reads the same on any cluster. A platform is one entry of `PLATFORMS`,
// and Struct8 sends only the ones it has an entry for too
// (src/lib/import/providers/clusterPlatforms.ts in the frontend repository; its
// gate test-k8s-cluster-scan-contract.mjs checks the two lists).
//
// FAILURE. A release whose metadata cannot be read, an API whose discovery does
// not answer, a kind that cannot be read in one namespace, and a chosen namespace
// the cluster does not have are each recorded in `errors`, and the rest is
// listed. A cluster that cannot be reached, or a list of releases or of
// namespaces that cannot be read at all, ends the script with a non-zero exit: an
// empty listing passing for a complete one is the worst outcome this action has.
// For the same reason, a scope that chooses namespaces and names no kind is
// refused before anything is called.
//
// SCOPE. Read from `cluster_scope.json` in the working directory, which Struct8
// pushes next to the manifest:
// `{ platform, cluster, region, requestId, namespaces, kinds }`, where
// `namespaces` is a list of names and `kinds` a list of `{ apiVersion, kind }`.
// Without `namespaces`, only the releases and the namespaces are listed, as in
// phase 3. Flags override the file.
//
// Usage:
//   node scan-cluster.mjs [--platform eks] [--cluster k8simp-cluster] [--region us-west-2]
//                         [--namespaces app-a,app-b] [--out cluster_inventory.json]
//                         [--request-id abc]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 2: the objects of the chosen namespaces, their kinds and the Argo CD Applications. */
export const INVENTORY_VERSION = 2;

/** No limit in practice: `helm list` stops at 256 releases unless told otherwise. */
const HELM_LIST_MAX = '100000';

/** The words an API server answers with when the caller has no access to it. */
const NO_ACCESS = /Unauthorized|provide credentials|forbidden/i;

/** What `kubectl get --raw` answers for a group or version the cluster does not serve. */
const NOT_SERVED = /\(NotFound\)|could not find the requested resource/i;

/** The annotation `kubectl apply` writes the whole applied manifest into. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** Argo CD's Application, listed from every namespace. */
const APPLICATION = { apiVersion: 'argoproj.io/v1alpha1', kind: 'Application' };

/** Where `readKind` lists a namespaced kind from every namespace. */
const EVERY_NAMESPACE = Symbol('every namespace');

/** The text of a failed command, without the noise around it. */
export function messageOf(error) {
	const stderr = String(error?.stderr ?? '').trim();
	const text = stderr || String(error?.message ?? error);
	return text.split('\n').slice(0, 5).join('\n');
}

/**
 * How a cluster is reached, per platform. The scope names one by its key.
 *
 *   label       the platform's name, in a message.
 *   kubeconfig  the command that writes the kubeconfig to `file`, as [command, args],
 *               under the sign-in the run already holds.
 *   noAccess    what a person does when the cluster refuses that sign-in.
 */
export const PLATFORMS = {
	eks: {
		label: 'EKS cluster',
		kubeconfig: ({ cluster, region }, file) => [
			'aws',
			['eks', 'update-kubeconfig', '--name', cluster, '--region', region, '--kubeconfig', file]
		],
		noAccess: 'The role this run signs in with has no access to the cluster: give it an access entry on the EKS cluster.'
	}
};

/** Why the cluster could not be read, in the words a person can act on. */
export function accessHint(message, platform) {
	return NO_ACCESS.test(message) ? ` ${platform.noAccess}` : '';
}

/**
 * The annotations of an object without the one `kubectl apply` leaves, or undefined
 * when none is left. Argo CD applies too: a namespace it creates with
 * CreateNamespace=true carries that annotation.
 */
function annotationsOf(metadata) {
	const kept = Object.entries(metadata?.annotations ?? {}).filter(([key]) => key !== LAST_APPLIED);
	return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** A namespace cut to the four fields the listing carries. */
function namespaceOf(item) {
	const metadata = item?.metadata ?? {};
	const annotations = annotationsOf(metadata);
	return {
		metadata: {
			name: metadata.name,
			...(metadata.labels ? { labels: metadata.labels } : {}),
			...(annotations ? { annotations } : {})
		},
		...(item?.status?.phase ? { status: { phase: item.status.phase } } : {})
	};
}

/** The same object without the keys whose value is undefined. */
function defined(object) {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** The `metadata` fields a person writes; the rest is the server's own. */
function metadataOf(metadata = {}) {
	const owners = (metadata.ownerReferences ?? []).map(({ apiVersion, kind, name, controller }) =>
		defined({ apiVersion, kind, name, controller })
	);
	return defined({
		name: metadata.name,
		namespace: metadata.namespace,
		labels: metadata.labels && Object.keys(metadata.labels).length > 0 ? metadata.labels : undefined,
		annotations: annotationsOf(metadata),
		ownerReferences: owners.length > 0 ? owners : undefined
	});
}

function isApplication({ apiVersion, kind }) {
	return kind === APPLICATION.kind && String(apiVersion).split('/')[0] === APPLICATION.apiVersion.split('/')[0];
}

/** Where a source of an Application comes from, without its Helm values or parameters. */
function sourceOf(source) {
	if (!source || typeof source !== 'object') return undefined;
	const { repoURL, path: sourcePath, chart, targetRevision, ref } = source;
	return defined({ repoURL, path: sourcePath, chart, targetRevision, ref });
}

/**
 * One object as the listing carries it. Exported for the test.
 *
 * A Secret keeps its type and the names of its keys; an Application keeps where it
 * syncs from and to, and what it syncs. Every other object keeps every top-level
 * field but `status`.
 */
export function objectOf(item) {
	const { apiVersion, kind, metadata, status, ...rest } = item ?? {};
	const head = { apiVersion, kind, metadata: metadataOf(metadata) };
	if (apiVersion === 'v1' && kind === 'Secret') {
		const keys = [...new Set([...Object.keys(rest.data ?? {}), ...Object.keys(rest.stringData ?? {})])].sort();
		return { ...head, ...defined({ type: rest.type, immutable: rest.immutable }), keys };
	}
	if (isApplication({ apiVersion, kind })) {
		const spec = rest.spec ?? {};
		const resources = (status?.resources ?? []).map(({ group, version, kind: k, namespace, name }) =>
			defined({ group: group || undefined, version, kind: k, namespace, name })
		);
		return {
			...head,
			spec: defined({
				project: spec.project,
				destination: spec.destination,
				source: sourceOf(spec.source),
				sources: Array.isArray(spec.sources) ? spec.sources.map(sourceOf) : undefined,
				syncPolicy: spec.syncPolicy
			}),
			...(resources.length > 0 ? { status: { resources } } : {})
		};
	}
	return { ...head, ...rest };
}

/**
 * Asks the API's discovery what each group and version serves. Returns, per
 * apiVersion, a Map kind -> { resource, namespaced }: empty when the cluster does
 * not serve that group or version, null when the question had no answer (then an
 * entry in `errors` says why).
 */
function discover(apiVersions, run, kubeconfig, errors) {
	const answers = new Map();
	for (const apiVersion of apiVersions) {
		const where = apiVersion.includes('/') ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
		try {
			const list = JSON.parse(run('kubectl', ['get', '--raw', where, '--kubeconfig', kubeconfig]));
			const kinds = new Map();
			for (const r of list?.resources ?? []) {
				// `deployments/scale` and the like are parts of another resource, not a list.
				if (!r?.kind || !r?.name || r.name.includes('/') || !(r.verbs ?? []).includes('list')) continue;
				if (!kinds.has(r.kind)) kinds.set(r.kind, { resource: r.name, namespaced: r.namespaced === true });
			}
			answers.set(apiVersion, kinds);
		} catch (error) {
			const message = messageOf(error);
			if (NOT_SERVED.test(message)) {
				answers.set(apiVersion, new Map());
			} else {
				errors.push({ source: `API ${apiVersion}`, message });
				answers.set(apiVersion, null);
			}
		}
	}
	return answers;
}

/**
 * Lists one kind: from each namespace of `where` when the kind lives in a
 * namespace, or once when it does not. `where` may be [EVERY_NAMESPACE].
 */
function readKind({ apiVersion, kind }, { resource, namespaced }, where, run, kubeconfig, errors) {
	const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
	// Named in full, so that a custom resource with the same plural in another group
	// is never the one listed. The core group has no group to name.
	const name = group ? `${resource}.${version}.${group}` : resource;
	const objects = [];
	for (const place of namespaced ? where : [null]) {
		const at = place === EVERY_NAMESPACE ? ['--all-namespaces'] : place ? ['--namespace', place] : [];
		try {
			const list = JSON.parse(run('kubectl', ['get', name, ...at, '--output', 'json', '--kubeconfig', kubeconfig]));
			for (const item of list?.items ?? []) objects.push(objectOf({ apiVersion, kind, ...item }));
		} catch (error) {
			const label = place === EVERY_NAMESPACE ? 'every namespace' : (place ?? 'the cluster');
			errors.push({ source: `${kind} in ${label}`, message: messageOf(error) });
		}
	}
	return objects;
}

/**
 * The objects of the chosen namespaces, the answer for each kind, and the Argo CD
 * Applications. `served` of a kind is true or false as the discovery answered, and
 * null when it did not answer.
 */
function listObjects(chosen, kinds, namespaces, run, kubeconfig, errors) {
	const present = new Set(namespaces.map((n) => n.metadata.name));
	const where = [];
	for (const name of chosen) {
		if (present.has(name)) where.push(name);
		else errors.push({ source: `namespace ${name}`, message: 'The cluster has no namespace with this name.' });
	}

	// An Application asked for as a kind would come twice: the listing already
	// carries every Application, from every namespace.
	const asked = [...kinds.filter((k) => !isApplication(k)), APPLICATION];
	const discovered = discover([...new Set(asked.map((k) => k.apiVersion))], run, kubeconfig, errors);

	const answers = [];
	const objects = [];
	let applications = [];
	for (const k of asked) {
		const served = discovered.get(k.apiVersion);
		const info = served?.get(k.kind);
		if (served === null) answers.push({ ...k, served: null });
		else if (!info) answers.push({ ...k, served: false });
		else {
			answers.push({ ...k, served: true, namespaced: info.namespaced });
			if (k === APPLICATION) applications = readKind(k, info, [EVERY_NAMESPACE], run, kubeconfig, errors);
			else objects.push(...readKind(k, info, where, run, kubeconfig, errors));
		}
	}
	return { kinds: answers, objects, applications };
}

/** The namespaces the scope chose, checked before anything is called. */
function chosenNamespaces(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((n) => typeof n !== 'string' || n === '')) {
		throw new Error('`namespaces` in cluster_scope.json is not a list of namespace names.');
	}
	return [...new Set(value)];
}

/** The kinds to list in them, checked the same way. */
function kindsToList(value, chosen) {
	if (chosen.length === 0) return [];
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('The scope chose namespaces and names no kind to list in them: `kinds` in cluster_scope.json is empty.');
	}
	const kinds = new Map();
	for (const k of value) {
		if (typeof k?.apiVersion !== 'string' || typeof k?.kind !== 'string' || !k.apiVersion || !k.kind) {
			throw new Error(`\`kinds\` in cluster_scope.json holds an entry that is not { apiVersion, kind }: ${JSON.stringify(k)}.`);
		}
		kinds.set(`${k.apiVersion} ${k.kind}`, { apiVersion: k.apiVersion, kind: k.kind });
	}
	return [...kinds.values()];
}

/**
 * Reads the cluster through `run(command, args)`, which returns the command's
 * stdout or throws. Exported for the test, which hands it a fake.
 *
 * Throws when the cluster cannot be reached or a list cannot be read.
 */
export function scanCluster({ platform: platformKey, cluster, region, requestId = null, namespaces: scopeNamespaces, kinds: scopeKinds }, run, kubeconfig) {
	// No default: a scope that names no platform is not taken for an EKS cluster.
	if (!platformKey) throw new Error('No platform: cluster_scope.json has no `platform`, and no --platform was given.');
	const platform = Object.hasOwn(PLATFORMS, platformKey) ? PLATFORMS[platformKey] : null;
	if (!platform) {
		throw new Error(`Unknown platform '${platformKey}': this engine reaches ${Object.keys(PLATFORMS).join(', ')}.`);
	}
	if (!cluster) throw new Error('No cluster name: cluster_scope.json has no `cluster`, and no --cluster was given.');
	if (!region) throw new Error('No region: cluster_scope.json has no `region`, and no --region was given.');
	const chosen = chosenNamespaces(scopeNamespaces);
	const kinds = kindsToList(scopeKinds, chosen);

	const errors = [];

	try {
		const [command, args] = platform.kubeconfig({ cluster, region }, kubeconfig);
		run(command, args);
	} catch (error) {
		const message = messageOf(error);
		throw new Error(`Could not reach the ${platform.label} '${cluster}' in ${region}: ${message}${accessHint(message, platform)}`);
	}

	let listed;
	try {
		listed = JSON.parse(
			run('helm', ['list', '--all-namespaces', '--max', HELM_LIST_MAX, '--output', 'json', '--kubeconfig', kubeconfig]) ||
				'[]'
		);
	} catch (error) {
		const message = messageOf(error);
		throw new Error(`Could not list the Helm releases of '${cluster}': ${message}${accessHint(message, platform)}`);
	}

	const releases = [];
	for (const entry of Array.isArray(listed) ? listed : []) {
		const name = entry?.name;
		const namespace = entry?.namespace;
		if (!name || !namespace) continue;
		try {
			const metadata = JSON.parse(
				run('helm', ['get', 'metadata', name, '--namespace', namespace, '--output', 'json', '--kubeconfig', kubeconfig])
			);
			if (!metadata?.chart) throw new Error('the answer has no chart name');
			releases.push({
				name,
				namespace,
				chart: metadata.chart,
				...(metadata.version ? { version: metadata.version } : {}),
				...(metadata.appVersion ? { appVersion: metadata.appVersion } : {}),
				...(entry.status ? { status: entry.status } : {})
			});
		} catch (error) {
			errors.push({ source: `release ${namespace}/${name}`, message: messageOf(error) });
		}
	}

	let namespaceList;
	try {
		namespaceList = JSON.parse(run('kubectl', ['get', 'namespaces', '--output', 'json', '--kubeconfig', kubeconfig]));
	} catch (error) {
		const message = messageOf(error);
		throw new Error(`Could not list the namespaces of '${cluster}': ${message}${accessHint(message, platform)}`);
	}
	const namespaces = (namespaceList?.items ?? []).filter((n) => n?.metadata?.name).map(namespaceOf);

	const inside = chosen.length > 0 ? listObjects(chosen, kinds, namespaces, run, kubeconfig, errors) : {};
	return { version: INVENTORY_VERSION, platform: platformKey, cluster, region, requestId, releases, namespaces, ...inside, errors };
}

/** The scope: the file Struct8 pushes, with the flags on top. */
export function readScope(args, file = 'cluster_scope.json') {
	const argOf = (name) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? null : args[i + 1];
	};
	let scope = {};
	try {
		scope = JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch {
		// Not fatal: running this by hand with flags behaves the same way.
	}
	const namespacesFlag = argOf('namespaces');
	return {
		platform: argOf('platform') ?? scope.platform ?? null,
		cluster: argOf('cluster') ?? scope.cluster ?? null,
		region: argOf('region') ?? scope.region ?? null,
		requestId: argOf('request-id') ?? scope.requestId ?? null,
		namespaces:
			namespacesFlag !== null
				? namespacesFlag
						.split(',')
						.map((n) => n.trim())
						.filter(Boolean)
				: (scope.namespaces ?? []),
		kinds: scope.kinds ?? []
	};
}

function main() {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf('--out');
	const out = outIndex === -1 ? 'cluster_inventory.json' : args[outIndex + 1];
	const scope = readScope(args);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct8-cluster-'));
	const kubeconfig = path.join(dir, 'kubeconfig');
	const run = (command, commandArgs) =>
		execFileSync(command, commandArgs, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

	try {
		const inventory = scanCluster(scope, run, kubeconfig);
		fs.writeFileSync(out, JSON.stringify(inventory, null, 2));
		const inside = inventory.objects
			? `, ${inventory.objects.length} object(s) in ${scope.namespaces.length} chosen namespace(s), ${inventory.applications.length} Argo CD Application(s)`
			: '';
		console.log(
			`${inventory.releases.length} release(s) and ${inventory.namespaces.length} namespace(s) listed in '${scope.cluster}'${inside}; ${inventory.errors.length} item(s) unreadable.`
		);
		for (const e of inventory.errors) console.log(`  unreadable: ${e.source}: ${e.message}`);
	} catch (error) {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	} finally {
		// The kubeconfig names the cluster and the command that gets a token; it
		// holds no token itself, and it still does not stay on the runner.
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
