/**
 * Eval suite definition, parsing, validation, and composition.
 *
 * A suite is the reviewable artifact of this package: a diffable file that says
 * what "good" means for an agent. Everything here therefore optimizes for
 * *loud* failure on a bad suite -- an unparseable assertion param must name the
 * case, the index, and the field, because the alternative is a suite that fails
 * at 3am in CI with a message that says "invalid input".
 */

import { readFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve as resolvePath } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface Assertion {
  /** Asserter id from the built-in registry, or a registered custom asserter. */
  type: string;
  params?: unknown;
}

export interface EvalCase {
  id: string;
  description?: string;
  tags?: string[];
  /** Glob or `/regex/flags` matched against a run's `scenario` and `runId`. */
  subject: string;
  assertions: Assertion[];
}

export interface EvalSuite {
  name: string;
  version?: string | number;
  description?: string;
  cases: EvalCase[];
}

export interface SuiteIssue {
  /** JSON-Pointer-ish path into the suite document, e.g. `/cases/2/assertions/0/params`. */
  path: string;
  message: string;
  code: string;
}

export class SuiteValidationError extends Error {
  readonly issues: SuiteIssue[];

  constructor(issues: SuiteIssue[], label: string) {
    const shown = issues.slice(0, 12);
    const body = shown.map((issue) => `  - ${issue.path || '/'}: ${issue.message}`).join('\n');
    const more = issues.length > shown.length ? `\n  ... and ${issues.length - shown.length} more` : '';
    super(`invalid eval suite ${label} (${issues.length} issue(s)):\n${body}${more}`);
    this.name = 'SuiteValidationError';
    this.issues = issues;
  }
}

export class SuiteCompositionError extends Error {
  readonly chain: readonly string[];

  constructor(chain: readonly string[], reason: string) {
    super(`eval suite composition failed: ${reason}\n  ${chain.join('\n  -> ')}`);
    this.name = 'SuiteCompositionError';
    this.chain = chain;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const assertionSchema = z
  .object({
    type: z.string().min(1, 'assertion type must be a non-empty asserter id'),
    params: z.unknown().optional(),
  })
  .strict();

const stringOrStrings = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/**
 * One schema for both real cases and include splices.
 *
 * A union would have produced `invalid_union` at `/cases/0` with two nested
 * candidate errors, which is exactly the kind of message that wastes an
 * afternoon. The `superRefine` below names the missing field directly, and the
 * caller dispatches on the presence of `include`.
 */
const caseEntrySchema = z
  .object({
    id: z.string().min(1).optional(),
    include: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
    subject: z.string().min(1).optional(),
    assertions: z.array(assertionSchema).min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.include !== undefined) {
      const stray = (['id', 'subject', 'assertions'] as const).filter((key) => value[key] !== undefined);
      for (const key of stray) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `an entry that includes another suite must not also set ${key}`,
        });
      }
      return;
    }
    if (value.id === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'case is missing id' });
    }
    if (value.subject === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'case is missing subject' });
    }
    if (value.assertions === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertions'],
        message: 'case is missing assertions',
      });
    }
  });

const includeSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const suiteSchema = z
  .object({
    name: z.string().min(1, 'suite name is required'),
    version: z.union([z.string(), z.number()]).optional(),
    description: z.string().optional(),
    include: includeSchema.optional(),
    cases: z.array(caseEntrySchema).optional(),
  })
  .strict();

type SuiteShape = z.infer<typeof suiteSchema>;
type CaseEntry = z.infer<typeof caseEntrySchema>;

interface ValidatedDocument {
  suite: Omit<EvalSuite, 'cases'>;
  cases: EvalCase[];
  entries: readonly CaseEntry[];
  includes: readonly string[];
}

// ---------------------------------------------------------------------------
// Zod -> SuiteIssue
// ---------------------------------------------------------------------------

function pointerSegment(segment: string | number): string {
  return typeof segment === 'number' ? String(segment) : segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function issuePath(path: readonly (string | number)[], prefix: string): string {
  const joined = path.map(pointerSegment).join('/');
  return joined === '' ? prefix : `${prefix}/${joined}`;
}

/**
 * Flatten a zod error, descending into union branches and keeping the branch
 * with the fewest issues -- the one the author was closest to satisfying.
 */
export function formatZodError(error: z.ZodError, prefix = ''): SuiteIssue[] {
  const out: SuiteIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === z.ZodIssueCode.invalid_union) {
      const branches = issue.unionErrors.map((branch) => formatZodError(branch, issuePath(issue.path, prefix)));
      const best = branches.reduce((a, b) => (b.length < a.length ? b : a), branches[0] ?? []);
      out.push(...(best.length > 0 ? best : [{ path: issuePath(issue.path, prefix), message: 'value matched none of the accepted shapes', code: issue.code }]));
      continue;
    }
    out.push({ path: issuePath(issue.path, prefix), message: issue.message, code: issue.code });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type SuiteFormat = 'json' | 'yaml';

export interface ParseSuiteOptions {
  /** Source label used in errors. */
  path?: string;
  /** Overrides extension-based detection. */
  format?: SuiteFormat;
}

export function detectFormat(path: string | undefined, text: string): SuiteFormat {
  const ext = path ? extname(path).toLowerCase() : '';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.json') return 'json';
  // No usable extension: JSON documents must start with a bracket, YAML suites
  // start with a key. A YAML file can also be a flow mapping, so this is a
  // heuristic -- and it is why `format` exists as an override.
  return /^\s*[[{]/.test(text) ? 'json' : 'yaml';
}

export function parseSuiteDocument(text: string, options: ParseSuiteOptions = {}): unknown {
  const format = options.format ?? detectFormat(options.path, text);
  const label = options.path ?? 'suite';
  if (format === 'json') {
    try {
      return JSON.parse(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SuiteValidationError([{ path: '', message: `not valid JSON: ${reason}`, code: 'json.parse' }], label);
    }
  }
  try {
    return parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SuiteValidationError([{ path: '', message: `not valid YAML: ${reason}`, code: 'yaml.parse' }], label);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Structural shape of an asserter, as far as the loader needs to know. */
export interface AsserterParamValidator {
  id: string;
  params: z.ZodTypeAny;
}

function isSplice(value: CaseEntry): value is CaseEntry & { include: string } {
  return typeof value.include === 'string';
}

function toEvalCase(value: unknown): EvalCase {
  const entry = value as {
    id?: string;
    description?: string;
    tags?: string[];
    subject?: string;
    assertions?: Assertion[];
  };
  // `superRefine` guarantees these; the guards exist so a future schema change
  // fails here loudly rather than producing a case with `undefined` fields that
  // silently matches every run.
  if (typeof entry.id !== 'string' || typeof entry.subject !== 'string' || !Array.isArray(entry.assertions)) {
    throw new Error('internal: suite schema produced an incomplete case');
  }
  const out: EvalCase = { id: entry.id, subject: entry.subject, assertions: entry.assertions };
  if (entry.description !== undefined) out.description = entry.description;
  if (entry.tags !== undefined) out.tags = entry.tags;
  return out;
}

/**
 * Validate one suite document. Include splicing is *not* performed here, so
 * this is the single place that turns untrusted JSON into an `EvalSuite`
 * fragment, and it reports every problem in the file rather than the first.
 */
export function validateSuiteDocument(
  raw: unknown,
  options: { path?: string; prefix?: string } = {},
): ValidatedDocument {
  const label = options.path ?? 'suite';
  const prefix = options.prefix ?? '';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SuiteValidationError(
      [{ path: prefix || '', message: 'suite must be a mapping/object at the top level', code: 'suite.not-an-object' }],
      label,
    );
  }

  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SuiteValidationError(formatZodError(parsed.error, prefix), label);
  }
  const shape: SuiteShape = parsed.data;

  const includes =
    shape.include === undefined
      ? []
      : typeof shape.include === 'string'
        ? [shape.include]
        : shape.include;

  const cases: EvalCase[] = [];
  for (const entry of shape.cases ?? []) {
    if (isSplice(entry)) continue;
    cases.push(toEvalCase(entry));
  }

  const suite: Omit<EvalSuite, 'cases'> = { name: shape.name };
  if (shape.version !== undefined) suite.version = shape.version;
  if (shape.description !== undefined) suite.description = shape.description;
  return { suite, cases, entries: shape.cases ?? [], includes };
}

/** Validate a standalone suite document (no includes resolved). */
export function parseSuite(text: string, options: ParseSuiteOptions = {}): EvalSuite {
  const raw = parseSuiteDocument(text, options);
  const { suite, cases } = validateSuiteDocument(raw, { path: options.path });
  if (cases.length === 0) {
    throw new SuiteValidationError(
      [{ path: '/cases', message: 'suite has no cases', code: 'suite.empty' }],
      options.path ?? 'suite',
    );
  }
  return { ...suite, cases };
}

// ---------------------------------------------------------------------------
// Assertion param validation
// ---------------------------------------------------------------------------

/**
 * Second validation pass: every assertion's `params` is checked against its
 * asserter's own schema. Kept separate from the suite schema on purpose, so a
 * suite file stays loadable by tools that do not have the asserter registry
 * (documentation generators, IDE schema printers) while the eval runner still
 * refuses to start on a typo'd threshold.
 */
export function validateAssertionParams(
  cases: readonly EvalCase[],
  asserters: readonly AsserterParamValidator[],
): SuiteIssue[] {
  const byId = new Map(asserters.map((asserter) => [asserter.id, asserter]));
  const issues: SuiteIssue[] = [];
  cases.forEach((testCase, caseIndex) => {
    testCase.assertions.forEach((assertion, assertionIndex) => {
      const asserter = byId.get(assertion.type);
      if (!asserter) {
        issues.push({
          path: `/cases/${caseIndex}/assertions/${assertionIndex}/type`,
          message: `unknown assertion type "${assertion.type}"`,
          code: 'assertion.unknown-type',
        });
        return;
      }
      const params = assertion.params ?? {};
      const result = asserter.params.safeParse(params);
      if (!result.success) {
        for (const issue of formatZodError(result.error, '')) {
          issues.push({
            path: `/cases/${caseIndex}/assertions/${assertionIndex}/params${issue.path}`,
            message: issue.message,
            code: `assertion.${issue.code}`,
          });
        }
      }
    });
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface SuiteLoadOptions {
  /** Base for relative include paths. Defaults to the including file's directory. */
  cwd?: string;
  maxIncludeDepth?: number;
  maxCases?: number;
  /** When present, every assertion is param-checked during load. */
  asserters?: readonly AsserterParamValidator[];
}

interface Expansion {
  suite: Omit<EvalSuite, 'cases'>;
  cases: EvalCase[];
}

/**
 * Load a suite and everything it includes.
 *
 * Includes are resolved depth-first and spliced in place, so a composed suite
 * reads top-to-bottom in the order its author wrote it -- a merged suite whose
 * order depended on filesystem enumeration would produce irreproducible gate
 * diffs. Cycles are a hard error naming the whole chain, because a cycle means
 * the suite was never really validated.
 */
export function loadSuiteFile(path: string, options: SuiteLoadOptions = {}): EvalSuite {
  const maxDepth = options.maxIncludeDepth ?? 10;
  const maxCases = options.maxCases ?? 5_000;
  const root = isAbsolute(path) ? path : resolvePath(options.cwd ?? '.', path);
  const seenIds = new Map<string, string>();
  const stack: string[] = [];

  const expand = (file: string, depth: number): Expansion => {
    if (stack.includes(file)) {
      throw new SuiteCompositionError([...stack, file], 'include cycle detected');
    }
    if (depth > maxDepth) {
      throw new SuiteCompositionError([...stack, file], `include depth exceeds ${maxDepth}`);
    }

    const text = readFileSync(file, 'utf8');
    const raw = parseSuiteDocument(text, { path: file });
    const { suite, entries, includes } = validateSuiteDocument(raw, { path: file });

    const collected: EvalCase[] = [];
    // The current file stays on the stack across *all* nested loads, so a
    // self-include at the suite level is reported as a cycle rather than as an
    // include-depth overflow.
    stack.push(file);
    try {
      for (const include of includes) {
        const target = isAbsolute(include) ? include : resolvePath(dirname(file), include);
        collected.push(...expand(target, depth + 1).cases);
      }
      for (const entry of entries) {
        if (isSplice(entry)) {
          const target = isAbsolute(entry.include) ? entry.include : resolvePath(dirname(file), entry.include);
          collected.push(...expand(target, depth + 1).cases);
          continue;
        }
        const testCase = toEvalCase(entry);
        const previous = seenIds.get(testCase.id);
        if (previous !== undefined) {
          throw new SuiteCompositionError(
            [file, previous],
            `duplicate case id "${testCase.id}" (also defined in ${previous})`,
          );
        }
        seenIds.set(testCase.id, file);
        collected.push(testCase);
        if (collected.length > maxCases) {
          throw new SuiteCompositionError([...stack, file], `composed suite exceeds ${maxCases} cases`);
        }
      }
    } finally {
      stack.pop();
    }

    return { suite, cases: collected };
  };

  const root_ = expand(root, 0);
  if (root_.cases.length === 0) {
    throw new SuiteValidationError(
      [{ path: '/cases', message: 'suite has no cases after resolving includes', code: 'suite.empty' }],
      root,
    );
  }
  if (options.asserters && options.asserters.length > 0) {
    const issues = validateAssertionParams(root_.cases, options.asserters);
    if (issues.length > 0) throw new SuiteValidationError(issues, root);
  }
  return { ...root_.suite, cases: root_.cases };
}

// ---------------------------------------------------------------------------
// Subject matching
// ---------------------------------------------------------------------------

const subjectCache = new Map<string, RegExp>();
const SUBJECT_CACHE_LIMIT = 512;

function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        // `**/` also swallows the separator, so `a/**/b` matches `a/b`.
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return `^${out}$`;
}

const REGEX_SUBJECT = /^\/(.*)\/([dgimsuvy]*)$/;

/**
 * Compile a suite subject.
 *
 * `/pattern/flags` is a regular expression; anything else is a glob, with `|`
 * allowed as a union so one case can cover `checkout-*` and `refund-*` without
 * a regex. Compiled subjects are memoized because a suite with 200 cases is
 * evaluated against every run and the glob work is pure overhead otherwise.
 */
export function compileSubject(subject: string): RegExp {
  const cached = subjectCache.get(subject);
  if (cached) return cached;

  let compiled: RegExp;
  const asRegex = REGEX_SUBJECT.exec(subject);
  if (asRegex) {
    try {
      compiled = new RegExp(asRegex[1]!, asRegex[2]!.replace('g', ''));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SuiteValidationError(
        [{ path: '/subject', message: `invalid regular expression: ${reason}`, code: 'subject.invalid-regex' }],
        subject,
      );
    }
  } else {
    const parts = subject.split('|').map((part) => globToRegExpSource(part));
    compiled = new RegExp(parts.join('|'));
  }

  if (subjectCache.size >= SUBJECT_CACHE_LIMIT) subjectCache.clear();
  subjectCache.set(subject, compiled);
  return compiled;
}

export interface SubjectTarget {
  runId: string;
  scenario: string;
}

/** A subject matches when it matches either the scenario label or the run id. */
export function subjectMatches(subject: string, target: SubjectTarget): boolean {
  const pattern = compileSubject(subject);
  return pattern.test(target.scenario) || pattern.test(target.runId);
}

// ---------------------------------------------------------------------------
// Helpers shared with the reporter
// ---------------------------------------------------------------------------

export function suiteIdentity(suite: EvalSuite): string {
  return suite.version === undefined ? suite.name : `${suite.name}@${suite.version}`;
}

export function caseTags(testCase: EvalCase): string[] {
  return [...new Set(testCase.tags ?? [])].sort();
}
