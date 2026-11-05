// Cloud Control API, called in this process instead of through the AWS CLI.
//
// WHY THIS EXISTS. A scan asks Cloud Control ~870 questions, and every one of
// them used to be an `aws` child process. Measured on 2026-09-06 against account
// 952133486861: `aws --version`, which touches no network at all, takes 478 ms,
// while a complete `cloudcontrol list-resources` takes 1341 ms. So a third of
// every call was the Python interpreter starting, not AWS answering.
//
// The proof that it was the local cost and not the network: the time PER CALL
// rose with the pool width -- 1341 ms alone, 2101 ms at width 10, 3499 ms at
// width 30. Waiting on a remote service does not do that; competing for CPU
// does. The runner has 4 cores, and that measurement was taken on 16.
//
// Signing by hand rather than with the AWS SDK is the smaller change: this
// repository has no package.json and no node_modules, and the pipeline would
// have to install one before it could scan. Everything here is node's own crypto
// and fetch.
//
// SCOPE. Only Cloud Control moves here, because that is where the calls are. The
// handful of `ec2 describe-*` and `s3api` calls stay on the CLI, where the
// synchronous version reads better and costs nothing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 'cloudcontrolapi';
// The JSON protocol's operation prefix, which is the service's internal name and
// not the one in the endpoint. `CloudApiService.ListResources` is what the wire
// expects; `cloudcontrolapi.ListResources` is refused.
const TARGET_PREFIX = 'CloudApiService';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * Credentials, the same ones the AWS CLI would have found.
 *
 * `pipeline.sh` writes a named profile with `aws configure set` and exports
 * `AWS_PROFILE=target`, so the profile file is the normal path here. Environment
 * variables win when they are set, which is what makes this runnable by hand.
 *
 * Read once: they are static keys, not a role being assumed per call, so there
 * is nothing to refresh inside one scan.
 */
export function resolveCredentials() {
	if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
		return {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID,
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
			sessionToken: process.env.AWS_SESSION_TOKEN || null
		};
	}

	const profile = process.env.AWS_PROFILE || 'default';
	const file =
		process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
	let text;
	try {
		text = fs.readFileSync(file, 'utf-8');
	} catch {
		throw new Error(`no credentials: ${file} is not readable and AWS_ACCESS_KEY_ID is unset`);
	}

	// A tiny INI reader rather than a dependency. Section headers and `key = value`
	// are the whole grammar the CLI writes with `aws configure set`.
	const wanted = {};
	let current = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const header = line.match(/^\[(.+)\]$/);
		if (header) {
			current = header[1].trim();
			continue;
		}
		if (current !== profile) continue;
		const at = line.indexOf('=');
		if (at === -1) continue;
		wanted[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}

	if (!wanted.aws_access_key_id || !wanted.aws_secret_access_key) {
		throw new Error(`no credentials: profile [${profile}] in ${file} has no key pair`);
	}
	return {
		accessKeyId: wanted.aws_access_key_id,
		secretAccessKey: wanted.aws_secret_access_key,
		sessionToken: wanted.aws_session_token || null
	};
}

/** SigV4 over a JSON POST. The canonical request is fixed except for the target. */
function sign({ region, credentials, target, body, now }) {
	const host = `${SERVICE}.${region}.amazonaws.com`;
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
	const dateStamp = amzDate.slice(0, 8);
	const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

	const headers = {
		'content-type': 'application/x-amz-json-1.0',
		host,
		'x-amz-date': amzDate,
		'x-amz-target': `${TARGET_PREFIX}.${target}`
	};
	if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

	const signedHeaders = Object.keys(headers).sort();
	const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]}\n`).join('');
	const signedHeaderList = signedHeaders.join(';');
	const payloadHash = sha256(body);

	const canonicalRequest = [
		'POST',
		'/',
		'',
		canonicalHeaders,
		signedHeaderList,
		payloadHash
	].join('\n');

	const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');

	const signature = crypto
		.createHmac(
			'sha256',
			hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), SERVICE), 'aws4_request')
		)
		.update(stringToSign, 'utf8')
		.digest('hex');

	headers.authorization =
		`${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
		`SignedHeaders=${signedHeaderList}, Signature=${signature}`;

	return { url: `https://${host}/`, headers };
}

/**
 * The error text, shaped like the one the AWS CLI printed.
 *
 * This is a contract, not a convenience: the caller classifies failures by
 * reading the message -- a type with no LIST handler, one that wants a parent
 * id, a throttle -- and those regexes were written against CLI output. Emitting
 * `<ExceptionName>: <message>` keeps every one of them working, so moving off
 * the CLI changes how the call is made and nothing about what is decided.
 */
function errorText(status, payload) {
	const type = String(payload?.__type ?? payload?.code ?? `HTTP ${status}`)
		.split('#')
		.pop();
	const detail = payload?.message ?? payload?.Message ?? '';
	return detail ? `${type}: ${detail}` : type;
}

const isThrottleStatus = (status, text) =>
	status === 429 || status === 503 || /Throttl|Rate exceeded|TooManyRequests/i.test(text);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Cloud Control call, retrying a throttle in place.
 *
 * WHY IN PLACE. Throttling used to be handled only by re-running the whole pass
 * at a narrower width (10 -> 4 -> 2 -> 1). That works, but it makes one throttled
 * type wait for every other type to finish before it is asked again, and the last
 * rounds are nearly serial. Backing off inside the call is what every AWS SDK
 * does, and it is what lets the two passes overlap without the throttle count
 * deciding the runtime.
 *
 * The pass-level ladder stays as the net underneath this. A call that is still
 * throttled after these attempts reports as throttled exactly as before, so the
 * guarantee that an unread type is never silently dropped is unchanged.
 */
export async function cloudControl(operation, payload, { region, credentials, attempts = 6 }) {
	const body = JSON.stringify(payload);
	let lastText = 'no answer';

	for (let attempt = 0; attempt < attempts; attempt++) {
		const { url, headers } = sign({ region, credentials, target: operation, body, now: new Date() });

		let response;
		try {
			response = await fetch(url, { method: 'POST', headers, body });
		} catch (error) {
			// A socket failure is worth one more try for the same reason a throttle is.
			lastText = `ConnectionError: ${String(error?.message ?? error)}`;
			if (attempt + 1 < attempts) await sleep(backoff(attempt));
			continue;
		}

		const text = await response.text();
		if (response.ok) {
			try {
				return { ok: true, value: text ? JSON.parse(text) : {} };
			} catch {
				return { ok: false, message: 'answer was not JSON' };
			}
		}

		let payloadOut = null;
		try {
			payloadOut = text ? JSON.parse(text) : null;
		} catch {
			payloadOut = null;
		}
		lastText = payloadOut ? errorText(response.status, payloadOut) : `HTTP ${response.status}: ${text.slice(0, 200)}`;

		if (isThrottleStatus(response.status, lastText) && attempt + 1 < attempts) {
			await sleep(backoff(attempt));
			continue;
		}
		return { ok: false, message: lastText };
	}

	return { ok: false, message: lastText };
}

/**
 * Exponential, with jitter, so a pool of workers does not retry in lockstep.
 *
 * The budget matters more than it looks. Once the calls stopped being child
 * processes they got fast enough to actually reach Cloud Control's rate limit --
 * measured 2026-09-06, the same 80-type sample throttled 3 types through the CLI
 * and 16 through this client, because the CLI was too slow to ask that often.
 * Throttling is now the binding constraint, so the retry has to be able to
 * outwait it: six attempts spans about twelve seconds.
 */
function backoff(attempt) {
	return Math.round((2 ** attempt) * 400 * (0.5 + Math.random()));
}
