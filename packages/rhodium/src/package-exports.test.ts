import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * RHOD-020 acceptance: the `rhodium` package must expose all seven sub-packages
 * as separate entry points so consumers can tree-shake imports. These tests
 * validate the shape of package.json's `exports` field, since that is what
 * Node/bun actually resolve at install time.
 */
describe('rhodium package.json exports', () => {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    exports: Record<string, unknown>;
    dependencies?: Record<string, string>;
  };
  const exportsMap = packageJson.exports;

  it('declares the top-level entry point', () => {
    const root = exportsMap['.'] as { types: string; import: string };
    expect(root).toBeDefined();
    expect(root.types).toMatch(/^\.\/dist\/index\.d\.ts$/);
    expect(root.import).toMatch(/^\.\/dist\/index\.js$/);
  });

  const subpaths = [
    'core',
    'capabilities',
    'budget',
    'discovery',
    'graph',
    'context',
    'testing',
  ];

  for (const sub of subpaths) {
    it(`declares the ./${sub} entry point with types + import conditions`, () => {
      const entry = exportsMap[`./${sub}`] as { types: string; import: string };
      expect(entry).toBeDefined();
      expect(entry.types).toBe(`./dist/${sub}.d.ts`);
      expect(entry.import).toBe(`./dist/${sub}.js`);
    });
  }

  it('lists every workspace sub-package as a dependency', () => {
    const deps = packageJson.dependencies ?? {};
    expect(deps['rhodium-core']).toBe('workspace:*');
    expect(deps['rhodium-capabilities']).toBe('workspace:*');
    expect(deps['rhodium-budget']).toBe('workspace:*');
    expect(deps['rhodium-discovery']).toBe('workspace:*');
    expect(deps['rhodium-graph']).toBe('workspace:*');
    expect(deps['rhodium-context']).toBe('workspace:*');
    expect(deps['rhodium-testing']).toBe('workspace:*');
  });
});
