#!/usr/bin/env node
//
// Lists one Kubernetes cluster and writes `cluster_inventory.json`, which Struct8
// turns into the selection of a cluster import. Phase 3 of the Kubernetes import
// (docs/importacao-kubernetes-fase-3-proposta.md in the frontend repository).
//
// WHAT IT LISTS, and nothing else:
//
//   - the Helm releases of every namespace, each with its chart name and its
//     version APART, as `helm get metadata` answers them. `helm list` joins the
//     two into one string (`external-secrets-2.15.0`), and splitting it back is a
//     guess when a version holds a hyphen (`1.0.0-rc.1`);
//   - the namespaces, as the Kubernetes API answers them, cut to `metadata.name`,
//     `labels`, `annotations` and `status.phase`. The phase that reads the objects
//     inside them reads the same shape.
//
// WHAT IT NEVER WRITES: the values of a release. `helm get metadata` does not
// answer them and nothing here asks for them. They can hold a password, and this
// file is committed to the customer's repository.
//
// WHAT THIS SCRIPT DOES NOT KNOW: any Struct8 type name, or which charts Struct8
// can draw. Struct8 decides that from its catalog; a chart added there changes
// nothing in this file.
//
// CREDENTIALS. Whatever the caller set up: pipeline.sh runs this after PASSO 2,
// signed in to the cloud of the target, as for the account scan. The cluster is
// reached through a kubeconfig written in a temporary file by the command of its
// PLATFORM (`PLATFORMS` below), whose user takes a token under that same sign-in.
// On EKS that is `aws eks update-kubeconfig` with `AWS_PROFILE=target`, and the
// role needs an access entry on the cluster, or every call answers Unauthorized.
//
// Only the kubeconfig and the advice on a refusal depend on the platform: what is
// listed, Helm releases and namespaces, reads the same on any cluster. A platform
// is one entry of `PLATFORMS`, and Struct8 sends only the ones it has an entry
// for too (src/lib/import/providers/clusterPlatforms.ts in the frontend
// repository; its gate test-k8s-cluster-scan-contract.mjs checks the two lists).
//
// FAILURE. A release whose metadata cannot be read is recorded in `errors` and
// left out, and the rest is listed. A cluster that cannot be reached, or a list
// that cannot be read at all, ends the script with a non-zero exit: an empty
// listing passing for a complete one is the worst outcome this action has.
//
// SCOPE. Read from `cluster_scope.json` in the working directory, which Struct8
// pushes next to the manifest: `{ platform, cluster, region, requestId }`. Flags
// override it.
//
// Usage:
//   node scan-cluster.mjs [--platform eks] [--cluster k8simp-cluster] [--region us-west-2]
//                         [--out cluster_inventory.json] [--request-id abc]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const INVENTORY_VERSION = 1;

/** No limit in practice: `helm list` stops at 256 releases unless told otherwise. */
const HELM_LIST_MAX = '100000';

/** The words an API server answers with when the caller has no access to it. */
const NO_ACCESS = /Unauthorized|provide credentials|forbidden/i;

/** The text of a failed command, without the noise around it. */
function messageOf(error) {
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
function accessHint(message, platform) {
	return NO_ACCESS.test(message) ? ` ${platform.noAccess}` : '';
}

/** A namespace cut to the four fields the listing carries. */
function namespaceOf(item) {
	const metadata = item?.metadata ?? {};
	return {
		metadata: {
			name: metadata.name,
			...(metadata.labels ? { labels: metadata.labels } : {}),
			...(metadata.annotations ? { annotations: metadata.annotations } : {})
		},
		...(item?.status?.phase ? { status: { phase: item.status.phase } } : {})
	};
}

/**
 * Reads the cluster through `run(command, args)`, which returns the command's
 * stdout or throws. Exported for the test, which hands it a fake.
 *
 * Throws when the cluster cannot be reached or a list cannot be read.
 */
export function scanCluster({ platform: platformKey, cluster, region, requestId = null }, run, kubeconfig) {
	// No default: a scope that names no platform is not taken for an EKS cluster.
	if (!platformKey) throw new Error('No platform: cluster_scope.json has no `platform`, and no --platform was given.');
	const platform = Object.hasOwn(PLATFORMS, platformKey) ? PLATFORMS[platformKey] : null;
	if (!platform) {
		throw new Error(`Unknown platform '${platformKey}': this engine reaches ${Object.keys(PLATFORMS).join(', ')}.`);
	}
	if (!cluster) throw new Error('No cluster name: cluster_scope.json has no `cluster`, and no --cluster was given.');
	if (!region) throw new Error('No region: cluster_scope.json has no `region`, and no --region was given.');

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

	return { version: INVENTORY_VERSION, platform: platformKey, cluster, region, requestId, releases, namespaces, errors };
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
	return {
		platform: argOf('platform') ?? scope.platform ?? null,
		cluster: argOf('cluster') ?? scope.cluster ?? null,
		region: argOf('region') ?? scope.region ?? null,
		requestId: argOf('request-id') ?? scope.requestId ?? null
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
		console.log(
			`${inventory.releases.length} release(s) and ${inventory.namespaces.length} namespace(s) listed in '${scope.cluster}', ${inventory.errors.length} release(s) unreadable.`
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
