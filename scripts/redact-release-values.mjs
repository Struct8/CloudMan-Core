#!/usr/bin/env node
//
// Takes the values of every Helm release out of a plan JSON, in place, before the
// read pass commits it as `generated_resources.json`.
//
// WHY. Importing a `helm_release` reads `metadata[0].values`: the values the release
// was installed with, as YAML-turned-JSON text. The provider does not mark them
// sensitive, so the redaction in pipeline.sh, which follows the provider's flags,
// leaves them in. They can hold a password, and this file goes to the customer's
// repository and from there to the browser. Measured on the k8simp lab
// (12/11/2026, hashicorp/helm 2.12.1): the read of `external-secrets` carried its
// `concurrent: 2` there, unflagged.
//
// WHAT STRUCT8 LOSES: nothing it reads. A release read from a cluster is drawn with
// no values and adopted with `reuse_values = true`, so the release keeps them
// (decision 2 of docs/importacao-kubernetes-fase-3-proposta.md, frontend
// repository). The names of the keys are what the import report will list, and
// they are kept here, in `release_value_keys`, without the values.
//
// WHERE. The same leaf lives in up to four sections, and each is handled: the
// before and after of `resource_changes` and `resource_drift`, `planned_values` and
// `prior_state`, root and child modules. It becomes `null`, as pipeline.sh does
// with a sensitive leaf, and the path goes to `redacted_attributes`.
//
// FAILURE. A file that cannot be read or written ends with a non-zero exit, and
// pipeline.sh then refuses to commit the file at all.
//
// Usage:
//   node redact-release-values.mjs generated_resources.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_TYPE = 'helm_release';

/** The top-level keys of a values text, or [] when it is not a JSON object. */
function keysOf(text) {
	if (typeof text !== 'string' || !text.trim()) return [];
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
	} catch {
		return [];
	}
}

/**
 * Nulls `metadata[*].values` in one set of attribute values. Returns the keys of
 * every values text it removed, per metadata index.
 */
function stripValues(values) {
	const removed = [];
	const metadata = values?.metadata;
	if (!Array.isArray(metadata)) return removed;
	metadata.forEach((entry, index) => {
		if (entry && typeof entry === 'object' && entry.values != null) {
			removed.push({ index, keys: keysOf(entry.values) });
			entry.values = null;
		}
	});
	return removed;
}

/** Redacts a parsed plan JSON in place. Exported for the test. */
export function redactReleaseValues(plan) {
	const paths = new Set();
	const keys = {};
	const record = (address, removed) => {
		for (const { index, keys: k } of removed) {
			paths.add(`${address}.metadata.${index}.values`);
			if (k.length > 0) keys[address] = [...new Set([...(keys[address] ?? []), ...k])].sort();
		}
	};

	for (const section of ['resource_changes', 'resource_drift']) {
		for (const change of plan?.[section] ?? []) {
			if (change?.type !== RELEASE_TYPE) continue;
			record(change.address, stripValues(change.change?.before));
			record(change.address, stripValues(change.change?.after));
		}
	}

	const walk = (module) => {
		if (!module) return;
		for (const resource of module.resources ?? []) {
			if (resource?.type === RELEASE_TYPE) record(resource.address, stripValues(resource.values));
		}
		for (const child of module.child_modules ?? []) walk(child);
	};
	walk(plan?.planned_values?.root_module);
	walk(plan?.prior_state?.values?.root_module);

	if (paths.size > 0) {
		plan.redacted_attributes = [...new Set([...(plan.redacted_attributes ?? []), ...paths])];
	}
	if (Object.keys(keys).length > 0) plan.release_value_keys = keys;
	return { removed: paths.size };
}

function main() {
	const file = process.argv[2];
	if (!file) {
		console.error('Usage: node redact-release-values.mjs <plan.json>');
		process.exit(2);
	}
	const plan = JSON.parse(fs.readFileSync(file, 'utf-8'));
	const { removed } = redactReleaseValues(plan);
	fs.writeFileSync(file, JSON.stringify(plan));
	console.log(`The values of ${removed} Helm release(s) removed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
