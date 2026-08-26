// Cases for complete-lambda-source.mjs.
//
// Usage: node complete-lambda-source.test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SCRIPT = path.join(HERE, 'complete-lambda-source.mjs');

let failures = 0;
function check(label, condition, detail) {
	console.log(`${condition ? 'PASS' : 'FAIL'} - ${label}`);
	if (!condition) {
		if (detail !== undefined) console.log(`         ${detail}`);
		failures++;
	}
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-source-'));

function run(config) {
	const dir = fs.mkdtempSync(path.join(TMP, 'case-'));
	const configPath = path.join(dir, 'generated_resources.tf');
	fs.writeFileSync(configPath, config, 'utf-8');

	let code = 0;
	let out = '';
	try {
		out = execFileSync(process.execPath, [SCRIPT, configPath], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (e) {
		code = e.status ?? 1;
		out = String(e.stdout ?? '') + String(e.stderr ?? '');
	}
	return {
		code,
		out,
		config: fs.readFileSync(configPath, 'utf-8'),
		dir
	};
}

// ──────────────────────────────────── what config generation actually wrote

const GERADO = `resource "aws_lambda_function" "import-lab-processor" {
  architectures                  = ["x86_64"]
  filename                       = ""
  function_name                  = "import-lab-processor"
  handler                        = "index.handler"
  image_uri                      = ""
  memory_size                    = 128
  role                           = "arn:aws:iam::952133486861:role/import-lab-processor-role-7kq2m1x8"
  runtime                        = "python3.12"
  s3_bucket                      = ""
  timeout                        = 3
  environment {
    variables = {
      TABLE = "import-lab-items"
    }
  }
}
`;

{
	const r = run(GERADO);
	check('exits 0 when it completed a function', r.code === 0, r.out);
	check('writes a filename', /filename\s*=\s*"imported_lambda_placeholder\.zip"/.test(r.config), r.config);
	check('and the archive it points at exists', fs.existsSync(path.join(r.dir, 'imported_lambda_placeholder.zip')));
	check(
		'the archive is a readable empty zip',
		fs.readFileSync(path.join(r.dir, 'imported_lambda_placeholder.zip')).subarray(0, 4).toString('latin1') ===
			'PK'
	);
	check('ignores the filename and the hash derived from it', /ignore_changes = \[filename, source_code_hash\]/.test(r.config), r.config);
	// The other two are cleared: left at "" they trip the same rule from the
	// other side -- "only one of ... can be specified".
	check('clears the empty image_uri', !/image_uri/.test(r.config), r.config);
	check('clears the empty s3_bucket', !/s3_bucket/.test(r.config), r.config);
	// THE CONTROL: everything the account DID answer for has to survive.
	check('keeps the runtime', /runtime\s+= "python3.12"/.test(r.config), r.config);
	check('keeps the role', /role\s+= "arn:aws:iam::952133486861:role/.test(r.config), r.config);
	check('keeps the nested environment block whole', /environment \{[\s\S]*TABLE = "import-lab-items"[\s\S]*\}/.test(r.config), r.config);
	check('says the code is not managed here', /code is not managed here/.test(r.out), r.out);
}

// ────────────────────────────── a function whose code location IS answerable

const COM_S3 = `resource "aws_lambda_function" "from-bucket" {
  filename      = ""
  function_name = "from-bucket"
  image_uri     = ""
  s3_bucket     = "meu-bucket-de-artefatos"
  s3_key        = "app/v3.zip"
}
`;

{
	const r = run(COM_S3);
	// It already names where the code is. Adding a placeholder would be a second
	// code location, which is the error this exists to avoid.
	check('leaves a function that already names its source', !/imported_lambda_placeholder/.test(r.config), r.config);
	check('and adds no lifecycle block to it', !/ignore_changes/.test(r.config), r.config);
	check('but still clears the empty siblings', !/image_uri/.test(r.config), r.config);
	check('keeping the real one', /s3_bucket\s+= "meu-bucket-de-artefatos"/.test(r.config), r.config);
}

// ──────────────────────────────────────────────── nothing of ours in the file

const SEM_LAMBDA = `resource "aws_s3_bucket" "uploads" {
  bucket = "import-lab-uploads"
}
`;

{
	const r = run(SEM_LAMBDA);
	check('exits 1 when there is no function to complete', r.code === 1, r.out);
	check('and leaves the file byte for byte', r.config === SEM_LAMBDA, r.config);
}

// ───────────────────────────── a key called filename that is not one of ours

const VARIAVEL = `resource "aws_lambda_function" "envia" {
  filename      = ""
  function_name = "envia"
  image_uri     = ""
  s3_bucket     = ""
  environment {
    variables = {
      filename = "relatorio.csv"
    }
  }
}
`;

{
	const r = run(VARIAVEL);
	// A variable of that name inside `environment` says nothing about where the
	// code lives, and reading it as a source would leave the function without one.
	check('a variable named filename is not read as a code location', /imported_lambda_placeholder/.test(r.config), r.config);
	check('and the variable itself is untouched', /filename = "relatorio.csv"/.test(r.config), r.config);
}

// ─────────────────────────────────────────── two functions, one already fine

const DUAS = `resource "aws_lambda_function" "a" {
  filename      = ""
  function_name = "a"
}

resource "aws_lambda_function" "b" {
  function_name = "b"
  image_uri     = "1234.dkr.ecr.mx-central-1.amazonaws.com/app:v2"
}
`;

{
	const r = run(DUAS);
	check('completes the one that needs it', /resource "aws_lambda_function" "a" \{\n  filename = "imported_lambda_placeholder\.zip"/.test(r.config), r.config);
	check('and leaves the container-based one alone', /image_uri     = "1234\.dkr\.ecr/.test(r.config), r.config);
	check('so only one lifecycle block was added', (r.config.match(/ignore_changes/g) ?? []).length === 1, r.config);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log(failures === 0 ? '\n✅ ALL CASES PASSED' : `\n❌ ${failures} CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
