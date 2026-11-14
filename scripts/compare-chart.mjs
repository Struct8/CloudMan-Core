#!/usr/bin/env node
//
// Compares the manifests of a Kubernetes environment with the objects a cluster
// has, and writes `chart_comparison.json`: for each object, whether a sync would
// leave it as it is, change it (and which fields), create it, or be refused. Phase 4
// of the Kubernetes import, stage 5 (docs/importacao-kubernetes-fase-4-proposta.md
// in the frontend repository, decision 7 and section 14).
//
// HOW. Each manifest goes through `kubectl apply --dry-run=server`: the client-side
// apply that Argo CD runs on a sync by default, sent to the API server with nothing
// written. It is also the patch `kubectl diff` computes; the only difference is the
// annotation below, which `kubectl diff` does not update and this comparison leaves
// out. The server answers with the object as the sync would leave it, and
// `kubectl get` with the object as it is. The two are compared field by field.
//
// Measured in the k8simp4 lab (13/11/2026): the client-side apply predicted every
// refusal and every removed field of the Argo CD sync that followed it, and the
// server-side one (`kubectl diff --server-side`) did not. A field that
// `kubectl.kubernetes.io/last-applied-configuration` names and the manifest does not
// have is REMOVED by that apply: this is what the comparison is for.
//
// WHAT IS LEFT OUT of the comparison, because a sync does not decide it:
//   - `status`, and the metadata the server keeps for itself (uid, resourceVersion,
//     generation, managedFields, creationTimestamp);
//   - the annotation `kubectl.kubernetes.io/last-applied-configuration`, which the
//     apply rewrites on every object it touches;
//   - the annotation `argocd.argoproj.io/tracking-id`, which Argo CD writes on every
//     object it syncs and the manifests do not carry.
//
// WHAT IT NEVER WRITES, because this file is committed to the customer's repository:
//   - a value of a Secret. A Secret's changes keep their paths (the key names) and
//     never a value, and a refusal of a Secret keeps no message: kubectl can quote
//     the manifest in it;
//   - the annotation `kubectl.kubernetes.io/last-applied-configuration`, which holds
//     the whole applied manifest, the values of a Secret in clear text included;
//   - the manifests themselves. The comparison names an object by its kind, name
//     and file, and a value appears only as a field's before and after, cut to
//     VALUE_MAX characters.
//
// WHAT THIS SCRIPT DOES NOT KNOW: any Struct8 type name. The manifests are what
// Struct8 generated; a kind is compared the same whatever it is. Two paths are named
// for what they mean to every kind: `spec.template`, the pod template of a workload,
// whose change replaces the pods (`restartsPods`), and the Secret's, for what it must
// not leak.
//
// CREDENTIALS. As scan-cluster.mjs: the kubeconfig is written by the command of the
// cluster's platform (`PLATFORMS`, shared with that script), under the sign-in
// pipeline.sh already holds. The role needs an access entry on the cluster that lets
// it read and patch the objects; a dry run writes nothing, and the API server still
// asks for the verb.
//
// FAILURE. An object that cannot be read or applied is recorded with its status and
// kubectl's message, and the rest is compared. A cluster that cannot be reached, a
// scope with no namespace, and a folder with no manifest end the script with a
// non-zero exit: a comparison with nothing compared passing for one that found no
// difference is the worst outcome this action has.
//
// SCOPE. Read from `chart_compare_scope.json` in the working directory, which
// Struct8 pushes next to the manifest and the manifests:
// `{ platform, cluster, region, requestId, namespace, manifests }`, where
// `namespace` is the namespace the environment's Application syncs into (the one an
// object without `metadata.namespace` lands in) and `manifests` the folder with the
// YAML files, relative to the working directory (`manifests` by default). Flags
// override the file.
//
// Usage:
//   node compare-chart.mjs [--platform eks] [--cluster k8simp-cluster] [--region us-west-2]
//                          [--namespace app-a] [--manifests manifests]
//                          [--out chart_comparison.json] [--request-id abc]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, accessHint, messageOf } from './scan-cluster.mjs';

/** 1: one entry per object of the manifests, with the fields that differ. */
export const COMPARISON_VERSION = 1;

/** The longest value kept as a field's before or after, in characters of JSON. */
export const VALUE_MAX = 300;

/** The annotation `kubectl apply` writes the whole applied manifest into. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

/** The annotation Argo CD writes on every object it syncs. */
const ARGO_TRACKING = 'argocd.argoproj.io/tracking-id';

/** The metadata the server keeps for itself. */
const SERVER_METADATA = ['uid', 'resourceVersion', 'generation', 'managedFields', 'creationTimestamp', 'selfLink'];

/** What kubectl answers for an object the cluster does not have. */
const NOT_FOUND = /\(NotFound\)|\bnot found\b/i;

/** What kubectl answers for a kind the cluster does not serve. */
const NOT_SERVED = /no matches for kind|resource mapping not found|the server doesn't have a resource type|could not find the requested resource/i;

/** A namespace name, as Kubernetes accepts it (RFC 1123 label). */
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** A key written as `.key` in a path; any other is written as `["key"]`. */
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/**
 * The documents of one YAML file, as text, without the ones that hold only
 * comments. Split on the `---` lines, as kubectl does; the generator writes a value
 * of several lines indented below its key, so a `---` at the start of a line is
 * always a separator.
 */
export function documentsOf(text) {
	return String(text)
		.replace(/\r\n/g, '\n')
		.split(/^---[ \t]*$/m)
		.map((doc) => doc.replace(/^\n+/, ''))
		.filter((doc) => doc.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#')));
}

/**
 * Who a document says it is, read from its top-level lines. A label for the entry
 * until kubectl answers with the object, and the only one when it refuses it.
 */
export function identityOf(doc) {
	const top = (key) => {
		const match = doc.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
		return match ? unquote(match[1]) : null;
	};
	const metadata = doc.match(/^metadata:[ \t]*\n((?:[ \t]+.*\n?|\n)*)/m)?.[1] ?? '';
	const field = (key) => {
		const match = metadata.match(new RegExp(`^  ${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
		return match ? unquote(match[1]) : null;
	};
	return { apiVersion: top('apiVersion'), kind: top('kind'), name: field('name'), namespace: field('namespace') };
}

function unquote(value) {
	const match = String(value).match(/^(['"])(.*)\1$/);
	return match ? match[2] : value;
}

/**
 * An object without what the comparison leaves out (see the header). Returns a
 * copy; `object` is not changed.
 */
export function comparable(object) {
	if (!object || typeof object !== 'object') return object;
	const copy = structuredClone(object);
	delete copy.status;
	const metadata = copy.metadata;
	if (metadata && typeof metadata === 'object') {
		for (const key of SERVER_METADATA) delete metadata[key];
		if (metadata.annotations && typeof metadata.annotations === 'object') {
			delete metadata.annotations[LAST_APPLIED];
			delete metadata.annotations[ARGO_TRACKING];
			if (Object.keys(metadata.annotations).length === 0) delete metadata.annotations;
		}
	}
	return copy;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyPath = (base, key) => (PLAIN_KEY.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`);

/** The `name` of every item, when each item is an object with a name of its own. */
function namesOf(list) {
	const names = list.map((item) => (isObject(item) && typeof item.name === 'string' ? item.name : null));
	return names.every((n) => n !== null) && new Set(names).size === names.length ? names : null;
}

/**
 * The fields where `after` differs from `before`, as `{ path, change }`:
 *   added      the field is only in `after`: the sync writes it;
 *   removed    the field is only in `before`: the sync deletes it;
 *   changed    a different value;
 *   reordered  a list whose items keep their names and change their order.
 *
 * A whole branch added or removed is one entry at its root. The items of a list are
 * matched by their `name` when each has a unique one (the containers, the volumes,
 * the ports of a Service), and by position otherwise; two lists of different length
 * without names are one `changed` entry.
 */
export function differences(before, after, base = '') {
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	if (isObject(before) && isObject(after)) {
		const out = [];
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const path = keyPath(base, key);
			if (!(key in after)) out.push({ path, change: 'removed', before: before[key] });
			else if (!(key in before)) out.push({ path, change: 'added', after: after[key] });
			else out.push(...differences(before[key], after[key], path));
		}
		return out;
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		const beforeNames = namesOf(before);
		const afterNames = namesOf(after);
		if (beforeNames && afterNames) {
			const out = [];
			for (const name of new Set([...beforeNames, ...afterNames])) {
				const path = `${base}[name=${name}]`;
				const i = beforeNames.indexOf(name);
				const j = afterNames.indexOf(name);
				if (j === -1) out.push({ path, change: 'removed', before: before[i] });
				else if (i === -1) out.push({ path, change: 'added', after: after[j] });
				else out.push(...differences(before[i], after[j], path));
			}
			const kept = afterNames.filter((n) => beforeNames.includes(n));
			const keptBefore = beforeNames.filter((n) => afterNames.includes(n));
			if (JSON.stringify(kept) !== JSON.stringify(keptBefore)) out.push({ path: base, change: 'reordered', before: keptBefore, after: kept });
			return out;
		}
		if (before.length === after.length) return before.flatMap((item, i) => differences(item, after[i], `${base}[${i}]`));
	}
	return [{ path: base, change: 'changed', before, after }];
}

/** A value cut for the file: JSON, at most VALUE_MAX characters. */
function shown(value) {
	if (value === undefined) return undefined;
	const text = JSON.stringify(value);
	return text.length <= VALUE_MAX ? value : `${text.slice(0, VALUE_MAX)}…`;
}

/** Whether a change replaces the pods: anything under the pod template of a workload. */
const touchesPodTemplate = (path) => path === 'spec.template' || path.startsWith('spec.template.') || path.startsWith('spec.template[');

/**
 * Compares one document with the cluster through `run(command, args)`, which
 * returns the command's stdout or throws. The document is in `file` on disk.
 *
 * The entry's `status`:
 *   same        a sync leaves the object as it is;
 *   different   a sync changes the fields in `changes`; `restartsPods` when one of
 *               them is in the pod template, which replaces the pods;
 *   absent      the cluster has no such object, and a sync creates it;
 *   refused     the API server refuses the object as the manifest writes it;
 *   not-served  the cluster does not serve the kind (a CRD that is not installed);
 *   unreadable  the object could not be read, mostly for lack of permission.
 * The last three carry kubectl's `message`, except on a Secret. A failure is named
 * by the manifest, with the environment's namespace when the manifest names none.
 */
export function compareDocument(doc, { file, source, namespace }, run, kubeconfig) {
	const said = identityOf(doc);
	const entry = {
		file: source,
		apiVersion: said.apiVersion,
		kind: said.kind,
		name: said.name,
		namespace: said.namespace ?? namespace
	};
	const secret = said.kind === 'Secret';
	// A manifest that names its namespace is read there: kubectl refuses a file whose
	// namespace differs from the one on the command line.
	const kubectl = (args) =>
		run('kubectl', [...args, '-f', file, '--namespace', said.namespace ?? namespace, '--output', 'json', '--kubeconfig', kubeconfig]);
	// kubectl names the file it read, which is the temporary copy of the document, as
	// is or quoted with its backslashes escaped: the message names the manifest
	// instead (measured in the k8simp7 lab, 14/11/2026).
	const withSource = (message) => [file, JSON.stringify(file).slice(1, -1)].reduce((text, p) => text.split(p).join(source), message);
	const failure = (status, error) => ({ ...entry, status, ...(secret ? {} : { message: withSource(messageOf(error)) }) });

	let live = null;
	try {
		live = JSON.parse(kubectl(['get']));
	} catch (error) {
		const message = messageOf(error);
		if (NOT_SERVED.test(message)) return failure('not-served', error);
		if (!NOT_FOUND.test(message)) return failure('unreadable', error);
	}

	let merged;
	try {
		merged = JSON.parse(kubectl(['apply', '--dry-run=server']));
	} catch (error) {
		return failure(NOT_SERVED.test(messageOf(error)) ? 'not-served' : 'refused', error);
	}

	// Named as the server answered: a cluster-scoped object (a StorageClass) has no
	// namespace there, whatever the command line said.
	const named = {
		...entry,
		apiVersion: merged.apiVersion ?? entry.apiVersion,
		kind: merged.kind ?? entry.kind,
		name: merged.metadata?.name ?? entry.name,
		namespace: merged.metadata?.namespace ?? null
	};
	if (!live) return { ...named, status: 'absent' };

	const changes = differences(comparable(live), comparable(merged)).map((c) => {
		if (secret) return { path: c.path, change: c.change };
		const out = { path: c.path, change: c.change };
		if ('before' in c) out.before = shown(c.before);
		if ('after' in c) out.after = shown(c.after);
		return out;
	});
	if (changes.length === 0) return { ...named, status: 'same' };
	return { ...named, status: 'different', restartsPods: changes.some((c) => touchesPodTemplate(c.path)), changes };
}

/** The YAML files of the folder, in order, with their path from the working directory. */
export function manifestFiles(dir) {
	const out = [];
	const walk = (folder) => {
		for (const item of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(folder, item.name);
			if (item.isDirectory()) walk(full);
			else if (/\.ya?ml$/i.test(item.name)) out.push(full);
		}
	};
	walk(dir);
	return out;
}

/**
 * Compares the manifests in `scope.manifests` with the cluster. Exported for the
 * test, which hands `run` a fake. Throws when the cluster cannot be reached or the
 * scope cannot be compared.
 */
export function compareChart(
	{ platform: platformKey, cluster, region, requestId = null, namespace, manifests = 'manifests' },
	run,
	kubeconfig,
	workDir
) {
	if (!platformKey) throw new Error('No platform: chart_compare_scope.json has no `platform`, and no --platform was given.');
	const platform = Object.hasOwn(PLATFORMS, platformKey) ? PLATFORMS[platformKey] : null;
	if (!platform) throw new Error(`Unknown platform '${platformKey}': this engine reaches ${Object.keys(PLATFORMS).join(', ')}.`);
	if (!cluster) throw new Error('No cluster name: chart_compare_scope.json has no `cluster`, and no --cluster was given.');
	if (!region) throw new Error('No region: chart_compare_scope.json has no `region`, and no --region was given.');
	if (!namespace || !NAMESPACE_NAME.test(String(namespace))) {
		throw new Error(`No valid namespace: the objects of a manifest without one land in the namespace the scope names, and it named '${namespace ?? ''}'.`);
	}
	const folder = path.resolve(manifests);
	if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`No folder '${manifests}' with the manifests to compare.`);
	const files = manifestFiles(folder);
	if (files.length === 0) throw new Error(`The folder '${manifests}' holds no YAML file to compare.`);

	try {
		const [command, args] = platform.kubeconfig({ cluster, region }, kubeconfig);
		run(command, args);
	} catch (error) {
		const message = messageOf(error);
		throw new Error(`Could not reach the ${platform.label} '${cluster}' in ${region}: ${message}${accessHint(message, platform)}`);
	}
	// One call to the API server before the objects, so a cluster that cannot be
	// reached or a refused sign-in ends the run here instead of filling the file with
	// the same failure once per object. `version` needs no permission on any object: a
	// role whose access entry covers only the environment's namespace passes it.
	try {
		run('kubectl', ['version', '--output', 'json', '--kubeconfig', kubeconfig]);
	} catch (error) {
		const message = messageOf(error);
		throw new Error(`Could not reach the API server of '${cluster}': ${message}${accessHint(message, platform)}`);
	}

	const objects = [];
	const errors = [];
	for (const full of files) {
		const source = path.relative(folder, full).split(path.sep).join('/');
		let docs;
		try {
			docs = documentsOf(fs.readFileSync(full, 'utf-8'));
		} catch (error) {
			errors.push({ source, message: messageOf(error) });
			continue;
		}
		docs.forEach((doc, i) => {
			const file = path.join(workDir, `doc-${objects.length}-${i}.yaml`);
			fs.writeFileSync(file, doc);
			try {
				objects.push(compareDocument(doc, { file, source, namespace }, run, kubeconfig));
			} finally {
				fs.rmSync(file, { force: true });
			}
		});
	}
	return { version: COMPARISON_VERSION, platform: platformKey, cluster, region, namespace, requestId, objects, errors };
}

/** The scope: the file Struct8 pushes, with the flags on top. */
export function readScope(args, file = 'chart_compare_scope.json') {
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
	return {
		platform: argOf('platform') ?? scope.platform ?? null,
		cluster: argOf('cluster') ?? scope.cluster ?? null,
		region: argOf('region') ?? scope.region ?? null,
		requestId: argOf('request-id') ?? scope.requestId ?? null,
		namespace: argOf('namespace') ?? scope.namespace ?? null,
		manifests: argOf('manifests') ?? scope.manifests ?? 'manifests'
	};
}

/** How many objects of each status, for the log line. */
export function summaryOf(comparison) {
	const count = {};
	for (const o of comparison.objects) count[o.status] = (count[o.status] ?? 0) + 1;
	return Object.entries(count)
		.map(([status, n]) => `${n} ${status}`)
		.join(', ');
}

function main() {
	const args = process.argv.slice(2);
	const outIndex = args.indexOf('--out');
	const out = outIndex === -1 ? 'chart_comparison.json' : args[outIndex + 1];
	const scope = readScope(args);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'struct8-compare-'));
	const kubeconfig = path.join(dir, 'kubeconfig');
	const run = (command, commandArgs) =>
		execFileSync(command, commandArgs, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

	try {
		const comparison = compareChart(scope, run, kubeconfig, dir);
		fs.writeFileSync(out, JSON.stringify(comparison, null, 2));
		console.log(
			`${comparison.objects.length} object(s) compared with '${scope.cluster}' in namespace ${scope.namespace}: ${summaryOf(comparison) || 'none'}; ${comparison.errors.length} file(s) unreadable.`
		);
		for (const o of comparison.objects.filter((x) => x.status !== 'same')) {
			const what = o.status === 'different' ? `${o.changes.length} field(s)${o.restartsPods ? ', replaces the pods' : ''}` : o.status;
			console.log(`  ${o.kind}/${o.name}: ${what}`);
		}
		for (const e of comparison.errors) console.log(`  unreadable: ${e.source}: ${e.message}`);
	} catch (error) {
		console.error(`❌ ${error.message}`);
		process.exitCode = 1;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
