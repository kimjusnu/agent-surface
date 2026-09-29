#!/usr/bin/env node
/**
 * `surface-eval` -- run a suite against recorded runs and fail the build.
 *
 *   node bin/eval.mjs --suite suites/demo.yaml --runs 'src/fixtures/*.json'
 *
 * Exit codes are the contract with CI:
 *   0  the gate passed
 *   1  the gate failed (threshold violation, failed case, or no coverage)
 *   2  the run could not start (bad arguments, invalid suite, unreadable file)
 *
 * It re-executes itself once with `--experimental-strip-types` when the host
 * Node is older than 22.6, so the CLI runs straight from source with no build
 * step and no `tsx` dependency. That is a deliberate trade: an eval gate that
 * needs a build to start is an eval gate that silently does not run.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_GATE_FAILED = 1;
const EXIT_CONFIG = 2;

const HERE = dirname(fileURLToPath(import.meta.url));
const RESPAWN_FLAG = 'AGENT_SURFACE_EVAL_RESPAWNED';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (process.features.typescript !== true && process.env[RESPAWN_FLAG] !== '1') {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings=ExperimentalWarning',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, [RESPAWN_FLAG]: '1' } },
  );
  process.exit(result.status === null ? EXIT_CONFIG : result.status);
}

register('./ts-loader.mjs', import.meta.url);

const engine = await import('../src/index.ts');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const HELP = `surface-eval -- agent quality gate

Usage:
  surface-eval --suite <file> (--run <file> | --runs <glob>) [options]

Inputs:
  -s, --suite <file>        eval suite (.yaml, .yml, .json). Required.
  -r, --run <file>          recorded run JSON. Repeatable. Globs allowed.
  -b, --baseline <file>     a previous report JSON, for regression gating.

Output:
      --json                print the JSON report instead of the terminal report
      --json-out <file>     write the JSON report to a file
      --junit <file>        write JUnit XML to a file (what CI parses)
      --color / --no-color  force ANSI on or off (default: auto)
      --ascii               use [ok]/[FAIL] markers instead of glyphs
      --verbose             print passing assertions too
      --list-asserters      print the asserter ids this build knows and exit

Gate thresholds:
      --fail-on <any|regression>   default: any
      --max-failure-rate <0..1>
      --min-pass-rate <0..1>
      --max-skipped-rate <0..1>
      --max-failed-cases <n>
      --max-p95-latency-ms <n>
      --max-p99-latency-ms <n>
      --max-cost-usd <n>
      --min-score <0..1>

Execution:
      --concurrency <n>     cases in flight; default 1 (deterministic)
      --fail-fast           stop scheduling cases after the first failure
  -h, --help                this text

Exit codes: 0 pass, 1 gate failed, 2 could not start.
`;

class ConfigError extends Error {}

function parseArgs(argv) {
  const options = {
    suite: null,
    runs: [],
    baseline: null,
    json: false,
    jsonOut: null,
    junit: null,
    color: null,
    ascii: false,
    verbose: false,
    listAsserters: false,
    help: false,
    failFast: false,
    concurrency: 1,
    thresholds: {},
  };

  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new ConfigError(`${flag} needs a value`);
    return value;
  };
  const takeNumber = (flag, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new ConfigError(`${flag} needs a number, got ${JSON.stringify(raw)}`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-s':
      case '--suite':
        options.suite = takeValue(arg, i);
        i++;
        break;
      case '-r':
      case '--run':
      case '--runs':
        options.runs.push(takeValue(arg, i));
        i++;
        break;
      case '-b':
      case '--baseline':
        options.baseline = takeValue(arg, i);
        i++;
        break;
      case '--json':
        options.json = true;
        break;
      case '--json-out':
        options.jsonOut = takeValue(arg, i);
        i++;
        break;
      case '--junit':
        options.junit = takeValue(arg, i);
        i++;
        break;
      case '--color':
        options.color = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '--ascii':
        options.ascii = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--list-asserters':
        options.listAsserters = true;
        break;
      case '--fail-fast':
        options.failFast = true;
        break;
      case '--concurrency':
        options.concurrency = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--fail-on': {
        const value = takeValue(arg, i);
        if (value !== 'any' && value !== 'regression') {
          throw new ConfigError(`--fail-on must be "any" or "regression", got ${JSON.stringify(value)}`);
        }
        options.thresholds.failOn = value;
        i++;
        break;
      }
      case '--max-failure-rate':
        options.thresholds.maxFailureRate = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--min-pass-rate':
        options.thresholds.minPassRate = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--max-skipped-rate':
        options.thresholds.maxSkippedRate = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--max-failed-cases':
        options.thresholds.maxFailedCases = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--max-p95-latency-ms':
        options.thresholds.maxP95LatencyMs = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--max-p99-latency-ms':
        options.thresholds.maxP99LatencyMs = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--max-cost-usd':
        options.thresholds.maxCostUsd = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      case '--min-score':
        options.thresholds.minScore = takeNumber(arg, takeValue(arg, i));
        i++;
        break;
      default:
        throw new ConfigError(`unknown argument ${JSON.stringify(arg)} (try --help)`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Globbing, without a dependency
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function expandPattern(pattern) {
  if (!/[*?]/.test(pattern)) return existsSync(pattern) ? [pattern] : [];
  const normalized = pattern.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dir = lastSlash === -1 ? '.' : normalized.slice(0, lastSlash);
  const base = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  if (!existsSync(dir)) return [];
  const pattern2 = globToRegExp(base);
  return readdirSync(dir)
    .filter((entry) => pattern2.test(entry))
    .sort()
    .map((entry) => (lastSlash === -1 ? entry : `${dir}/${entry}`));
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${what} ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${what} ${path} is not valid JSON: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT_CONFIG;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  if (options.listAsserters) {
    const registry = engine.createRegistry();
    for (const id of registry.ids()) process.stdout.write(`${id}\n`);
    return EXIT_OK;
  }

  if (!options.suite) {
    process.stderr.write('--suite is required (try --help)\n');
    return EXIT_CONFIG;
  }
  if (options.runs.length === 0) {
    process.stderr.write('at least one --run is required; a gate with no runs has no evidence\n');
    return EXIT_CONFIG;
  }

  const runPaths = [...new Set(options.runs.flatMap(expandPattern))].sort();
  const missing = options.runs.filter((pattern) => expandPattern(pattern).length === 0);
  if (runPaths.length === 0) {
    process.stderr.write(`no run fixtures matched ${options.runs.join(', ')}\n`);
    return EXIT_CONFIG;
  }
  if (missing.length > 0) {
    process.stderr.write(`warning: no files matched ${missing.join(', ')}\n`);
  }

  const suitePath = resolve(options.suite);
  const registry = engine.createRegistry();

  let suite;
  try {
    suite = engine.loadSuiteFile(suitePath, { asserters: registry.list() });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT_CONFIG;
  }

  const runs = runPaths.map((path) => engine.loadRunInput(resolve(path)));
  const baseline = options.baseline ? engine.reportFromJson(readJson(resolve(options.baseline), 'baseline')) : undefined;

  return engine
    .runSuite(suite, runs, { concurrency: options.concurrency, failFast: options.failFast, registry })
    .then((report) => {
      const decision = engine.evaluateGate(report, options.thresholds, {
        ...(baseline ? { baseline } : {}),
      });

      if (options.jsonOut) {
        writeFileSync(resolve(options.jsonOut), `${engine.renderJsonReport(report)}\n`, 'utf8');
      }
      if (options.junit) {
        writeFileSync(resolve(options.junit), `${engine.renderJUnitXml(report)}\n`, 'utf8');
      }

      const useColor = options.color ?? engine.shouldUseColor(process.stdout, process.env);
      if (options.json) {
        process.stdout.write(`${engine.renderJsonReport(report)}\n`);
      } else {
        const terminal = engine.renderTerminal(report, {
          color: useColor,
          ascii: options.ascii,
          verbose: options.verbose,
        });
        process.stdout.write(`${terminal}\n\n${engine.renderGate(decision)}\n`);
      }
      return decision.passed ? EXIT_OK : EXIT_GATE_FAILED;
    })
    .catch((error) => {
      process.stderr.write(`eval run failed: ${error && error.stack ? error.stack : String(error)}\n`);
      return EXIT_CONFIG;
    });
}

process.exitCode = await main(process.argv.slice(2));
