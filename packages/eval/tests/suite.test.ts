import { describe, expect, it } from 'vitest';

import {
  compileSubject,
  detectFormat,
  formatZodError,
  loadSuiteFile,
  parseSuite,
  SuiteCompositionError,
  SuiteValidationError,
  subjectMatches,
  suiteIdentity,
  validateAssertionParams,
  validateSuiteDocument,
  type EvalCase,
} from '../src/suite.js';
import { createRegistry } from '../src/asserters.js';
import { z } from 'zod';
import { suiteFixturePath } from './helpers.js';

const MINIMAL = JSON.stringify({
  name: 'minimal',
  cases: [
    {
      id: 'c/one',
      subject: '*',
      assertions: [{ type: 'no-errors' }],
    },
  ],
});

describe('parseSuite -- valid documents', () => {
  it('parses a minimal JSON suite', () => {
    const suite = parseSuite(MINIMAL);
    expect(suite.name).toBe('minimal');
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]?.assertions[0]?.type).toBe('no-errors');
  });

  it('keeps description, tags, and assertion params', () => {
    const suite = parseSuite(
      JSON.stringify({
        name: 'rich',
        version: 3,
        description: 'has everything',
        cases: [
          {
            id: 'c/rich',
            description: 'a case',
            tags: ['b', 'a', 'a'],
            subject: 'x-*',
            assertions: [{ type: 'max-latency', params: { maxMs: 100 } }],
          },
        ],
      }),
    );
    expect(suite.version).toBe(3);
    expect(suite.description).toBe('has everything');
    expect(suite.cases[0]?.description).toBe('a case');
    expect(suite.cases[0]?.tags).toEqual(['b', 'a', 'a']);
    expect(suite.cases[0]?.assertions[0]?.params).toEqual({ maxMs: 100 });
  });

  it('parses YAML', () => {
    const suite = parseSuite(
      ['name: yaml-suite', 'cases:', '  - id: c/yaml', '    subject: "*"', '    assertions:', '      - type: no-errors'].join('\n'),
      { path: 'inline.yaml' },
    );
    expect(suite.name).toBe('yaml-suite');
    expect(suite.cases[0]?.id).toBe('c/yaml');
  });

  it('detects format by extension', () => {
    expect(detectFormat('a.yaml', '{}')).toBe('yaml');
    expect(detectFormat('a.YML', '{}')).toBe('yaml');
    expect(detectFormat('a.json', 'name: x')).toBe('json');
  });

  it('sniffs format when there is no usable extension', () => {
    expect(detectFormat(undefined, '  {"name":"x"}')).toBe('json');
    expect(detectFormat(undefined, 'name: x')).toBe('yaml');
  });

  it('honours an explicit format override', () => {
    const suite = parseSuite(
      'name: forced\ncases:\n  - id: c1\n    subject: "*"\n    assertions:\n      - type: no-errors\n',
      { format: 'yaml' },
    );
    expect(suite.name).toBe('forced');
    expect(suite.cases).toHaveLength(1);
  });
});

describe('parseSuite -- invalid documents report a path', () => {
  const issuesOf = (text: string, path?: string): SuiteValidationError => {
    try {
      parseSuite(text, path === undefined ? {} : { path });
    } catch (error) {
      if (error instanceof SuiteValidationError) return error;
      throw error;
    }
    throw new Error('expected a SuiteValidationError');
  };

  it('reports unparseable JSON', () => {
    expect(issuesOf('{ not json').issues[0]?.code).toBe('json.parse');
  });

  it('reports unparseable YAML', () => {
    expect(issuesOf('name: [unclosed', 'broken.yaml').issues[0]?.code).toBe('yaml.parse');
  });

  it('rejects a non-object document', () => {
    expect(issuesOf('[]').issues[0]?.code).toBe('suite.not-an-object');
  });

  it('reports a missing name at /name', () => {
    expect(issuesOf(JSON.stringify({ cases: [] })).issues[0]?.path).toBe('/name');
  });

  it('rejects unknown top-level keys', () => {
    const issues = issuesOf(JSON.stringify({ name: 'x', nope: 1, cases: [] })).issues;
    expect(issues[0]?.code).toBe('unrecognized_keys');
    expect(issues[0]?.path).toBe('');
  });

  it('reports a case with no id at /cases/0/id', () => {
    const issues = issuesOf(JSON.stringify({ name: 'x', cases: [{ subject: '*', assertions: [{ type: 'a' }] }] })).issues;
    expect(issues.map((issue) => issue.path)).toContain('/cases/0/id');
  });

  it('reports a case with no subject at /cases/0/subject', () => {
    const issues = issuesOf(JSON.stringify({ name: 'x', cases: [{ id: 'a', assertions: [{ type: 'a' }] }] })).issues;
    expect(issues.map((issue) => issue.path)).toContain('/cases/0/subject');
  });

  it('reports a case with no assertions at /cases/0/assertions', () => {
    const issues = issuesOf(JSON.stringify({ name: 'x', cases: [{ id: 'a', subject: '*' }] })).issues;
    expect(issues.map((issue) => issue.path)).toContain('/cases/0/assertions');
  });

  it('reports an empty assertions array', () => {
    const issues = issuesOf(JSON.stringify({ name: 'x', cases: [{ id: 'a', subject: '*', assertions: [] }] })).issues;
    expect(issues[0]?.path).toBe('/cases/0/assertions');
  });

  it('reports an assertion with no type at the assertion index', () => {
    const issues = issuesOf(
      JSON.stringify({ name: 'x', cases: [{ id: 'a', subject: '*', assertions: [{ params: {} }] }] }),
    ).issues;
    expect(issues[0]?.path).toBe('/cases/0/assertions/0/type');
  });

  it('rejects unknown keys inside an assertion', () => {
    const issues = issuesOf(
      JSON.stringify({ name: 'x', cases: [{ id: 'a', subject: '*', assertions: [{ type: 'a', wat: 1 }] }] }),
    ).issues;
    expect(issues[0]?.code).toBe('unrecognized_keys');
    expect(issues[0]?.path).toBe('/cases/0/assertions/0');
  });

  it('rejects a case that both includes and declares an id', () => {
    const issues = issuesOf(JSON.stringify({ name: 'x', cases: [{ id: 'a', include: 'b.yaml' }] })).issues;
    expect(issues.map((issue) => issue.path)).toContain('/cases/0/id');
  });

  it('rejects a suite with zero cases', () => {
    expect(issuesOf(JSON.stringify({ name: 'x', cases: [] })).issues[0]?.code).toBe('suite.empty');
  });

  it('accepts a suite whose only content is includes', () => {
    const suite = loadSuiteFile(suiteFixturePath('root-include.yaml'));
    expect(suite.cases.map((entry) => entry.id)).toEqual(['base/alpha', 'base/beta', 'root/gamma']);
  });

  it('collects every problem in the file rather than the first', () => {
    const issues = issuesOf(
      JSON.stringify({
        name: 'x',
        cases: [
          { subject: '*', assertions: [{ type: 'a' }] },
          { id: 'b', assertions: [] },
        ],
      }),
    ).issues;
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe('suite composition', () => {
  it('splices suite-level includes before local cases', () => {
    const suite = loadSuiteFile(suiteFixturePath('root-include.yaml'));
    expect(suite.cases[0]?.id).toBe('base/alpha');
    expect(suite.cases.at(-1)?.id).toBe('root/gamma');
  });

  it('splices a case-level include in place', () => {
    const suite = loadSuiteFile(suiteFixturePath('splice.yaml'));
    expect(suite.cases.map((entry) => entry.id)).toEqual(['splice/alpha', 'base/alpha', 'base/beta']);
  });

  it('detects a two-file include cycle and names the chain', () => {
    let thrown: unknown;
    try {
      loadSuiteFile(suiteFixturePath('cycle-a.yaml'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SuiteCompositionError);
    const error = thrown as SuiteCompositionError;
    expect(error.message).toContain('include cycle detected');
    expect(error.chain.length).toBeGreaterThanOrEqual(3);
    expect(error.chain[0]).toContain('cycle-a.yaml');
  });

  it('detects a self-include at the suite level', () => {
    expect(() => loadSuiteFile(suiteFixturePath('self-include.yaml'))).toThrow(/include cycle detected/);
  });

  it('rejects duplicate case ids across included files and names both files', () => {
    let thrown: unknown;
    try {
      loadSuiteFile(suiteFixturePath('dup-root.yaml'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SuiteCompositionError);
    expect((thrown as SuiteCompositionError).message).toContain('duplicate case id "shared/id"');
    expect((thrown as SuiteCompositionError).message).toContain('dup-a.yaml');
  });

  it('stops at the include-depth limit instead of recursing forever', () => {
    expect(() =>
      loadSuiteFile(suiteFixturePath('cycle-a.yaml'), { maxIncludeDepth: 0 }),
    ).toThrow(/include depth exceeds 0/);
  });
});

describe('assertion param validation', () => {
  const registry = createRegistry();

  it('accepts the bundled demo suite against the real registry', () => {
    const suite = loadSuiteFile(suiteFixturePath('../../suites/demo.yaml'), { asserters: registry.list() });
    expect(suite.cases.length).toBeGreaterThan(5);
  });

  it('reports an unknown asserter type with a path', () => {
    const issues = validateAssertionParams(
      [{ id: 'c', subject: '*', assertions: [{ type: 'no-such-asserter' }] }],
      registry.list(),
    );
    expect(issues[0]?.path).toBe('/cases/0/assertions/0/type');
    expect(issues[0]?.message).toContain('no-such-asserter');
  });

  it('reports a param of the wrong type with a path under params', () => {
    const issues = validateAssertionParams(
      [{ id: 'c', subject: '*', assertions: [{ type: 'max-latency', params: { maxMs: 'nope' } }] }],
      registry.list(),
    );
    expect(issues[0]?.path).toBe('/cases/0/assertions/0/params/maxMs');
  });

  it('reports a bad enum member', () => {
    const issues = validateAssertionParams(
      [{ id: 'c', subject: '*', assertions: [{ type: 'tool-count', params: { tool: 'x', op: 'sideways', count: 1 } }] }],
      registry.list(),
    );
    expect(issues.some((issue) => issue.path.endsWith('/op'))).toBe(true);
  });

  it('refuses to load a suite with bad params when a registry is supplied', () => {
    expect(() =>
      loadSuiteFile(suiteFixturePath('bad-params.yaml'), { asserters: registry.list() }),
    ).toThrow(SuiteValidationError);
  });

  it('loads the same file when no registry is supplied', () => {
    expect(loadSuiteFile(suiteFixturePath('bad-params.yaml')).cases).toHaveLength(2);
  });

  it('keeps union branch errors specific to the closest shape', () => {
    const issues = formatZodError(
      z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()]).safeParse({ a: 1 }).error!,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('/a');
  });
});

describe('subject matching', () => {
  const target = (runId: string, scenario = runId): { runId: string; scenario: string } => ({ runId, scenario });

  it('matches a plain star glob', () => {
    expect(subjectMatches('*', target('anything'))).toBe(true);
  });

  it('matches a prefix glob', () => {
    expect(subjectMatches('checkout-*', target('checkout-1'))).toBe(true);
    expect(subjectMatches('checkout-*', target('refund-1'))).toBe(false);
  });

  it('does not let a single star cross a slash', () => {
    expect(subjectMatches('a/*', target('team-a/b-1'))).toBe(false);
    expect(subjectMatches('a/*', target('a/b-1'))).toBe(true);
  });

  it('matches ? as exactly one character', () => {
    expect(subjectMatches('run_?', target('run_1'))).toBe(true);
    expect(subjectMatches('run_?', target('run_12'))).toBe(false);
  });

  it('treats | as a union of globs', () => {
    expect(subjectMatches('checkout-*|refund-*', target('refund-9'))).toBe(true);
    expect(subjectMatches('checkout-*|refund-*', target('ops-9'))).toBe(false);
  });

  it('matches a regular expression subject', () => {
    expect(subjectMatches('/^run_\\d+$/', target('run_42'))).toBe(true);
    expect(subjectMatches('/^run_\\d+$/i', target('RUN_42'))).toBe(true);
    expect(subjectMatches('/^run_\\d+$/', target('run_x'))).toBe(false);
  });

  it('matches against scenario as well as runId', () => {
    expect(subjectMatches('refund-flow', target('run_9', 'refund-flow'))).toBe(true);
  });

  it('escapes regex metacharacters in a glob', () => {
    expect(subjectMatches('a.b', target('a.b'))).toBe(true);
    expect(subjectMatches('a.b', target('axb'))).toBe(false);
  });

  it('throws a SuiteValidationError for an invalid regex subject', () => {
    expect(() => compileSubject('/([unclosed/')).toThrow(SuiteValidationError);
  });

  it('memoizes compiled subjects', () => {
    expect(compileSubject('memo-*')).toBe(compileSubject('memo-*'));
  });
});

describe('suite identity', () => {
  it('omits the version when there is none', () => {
    expect(suiteIdentity({ name: 'x', cases: [] })).toBe('x');
  });

  it('appends the version when present', () => {
    expect(suiteIdentity({ name: 'x', version: 2, cases: [] })).toBe('x@2');
  });
});

describe('validateSuiteDocument', () => {
  it('separates real cases from include splices', () => {
    const result = validateSuiteDocument({
      name: 'mixed',
      include: 'base.yaml',
      cases: [{ include: 'base.yaml' }, { id: 'x', subject: '*', assertions: [{ type: 'no-errors' }] }],
    });
    expect(result.includes).toEqual(['base.yaml']);
    expect(result.cases).toHaveLength(1);
    expect(result.entries).toHaveLength(2);
  });

  it('preserves a version-only suite without cases for the loader to expand', () => {
    const result = validateSuiteDocument({ name: 'v', version: '2' });
    expect(result.cases).toHaveLength(0);
    expect(result.suite.version).toBe('2');
  });

  it('leaves optional fields absent rather than undefined', () => {
    const testCase: EvalCase = { id: 'x', subject: '*', assertions: [{ type: 'no-errors' }] };
    const result = validateSuiteDocument({ name: 'n', cases: [testCase] });
    expect('description' in (result.cases[0] as object)).toBe(false);
    expect('tags' in (result.cases[0] as object)).toBe(false);
  });
});
