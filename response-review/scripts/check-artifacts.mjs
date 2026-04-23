import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {
  getResponseReviewWebBundlePaths,
  transpileResponseReviewWebSource,
} from './web-bundle.mjs';

const {sourcePath, outputPath} = getResponseReviewWebBundlePaths();

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(outputPath)) {
  fail(
    `Missing generated response-review web artifact: ${outputPath}\nRun npm run build:web --workspace response-review to regenerate it.`,
  );
}

const source = readFileSync(sourcePath, 'utf8');
const expected = transpileResponseReviewWebSource(source);
const actual = readFileSync(outputPath, 'utf8');

if (actual !== expected) {
  fail(
    `Generated response-review web artifact is stale or hand-edited: ${outputPath}\nRun npm run build:web --workspace response-review and do not edit web/app.js directly.`,
  );
}

const syntaxCheck = spawnSync(process.execPath, ['--check', outputPath], {
  encoding: 'utf8',
});

if (syntaxCheck.stdout) process.stdout.write(syntaxCheck.stdout);
if (syntaxCheck.stderr) process.stderr.write(syntaxCheck.stderr);

if (syntaxCheck.status !== 0) {
  process.exit(syntaxCheck.status ?? 1);
}
