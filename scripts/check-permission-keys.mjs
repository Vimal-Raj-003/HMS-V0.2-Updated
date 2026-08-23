/**
 * `phase-00 §0.3`: "CI fails on any route without a permission key."
 *
 * `PolicyGuard` already refuses such a route at request time, which is the
 * safety net. This is the earlier one: a route that denies everybody is a
 * production incident discovered by a user, and the whole point of a deny-by-
 * default posture is that the failure is found before it ships.
 *
 * Parsed with the TypeScript compiler rather than matched with a regular
 * expression. Decorators nest, wrap across lines, and appear on both the class
 * and the method; a regex over that either misses a real gap or invents one, and
 * a check nobody trusts gets deleted. The compiler is already a dependency.
 *
 * A route satisfies the rule with exactly one of:
 *   @Permission('key')   — the normal case
 *   @Public()            — login, health, the OpenAPI document
 *   @AuthenticatedOnly() — session introspection only; see permission.decorator.ts
 * on the method itself or on its controller class.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = 'services/api/src';
const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All']);
const AUTHORISING_DECORATORS = new Set(['Permission', 'Public', 'AuthenticatedOnly']);

/** @returns {string[]} */
function controllerFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...controllerFiles(path));
    } else if (entry.endsWith('.controller.ts') && !entry.endsWith('.spec.ts')) {
      found.push(path);
    }
  }
  return found;
}

/** Decorator names on a node, e.g. `@Get(':id')` -> "Get". */
function decoratorNames(node) {
  const names = [];
  for (const modifier of ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []) {
    const expression = modifier.expression;
    const callee = ts.isCallExpression(expression) ? expression.expression : expression;
    if (ts.isIdentifier(callee)) names.push(callee.text);
  }
  return names;
}

const problems = [];
let routesChecked = 0;
const files = controllerFiles(ROOT);

for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);

  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    const classDecorators = decoratorNames(statement);
    if (!classDecorators.includes('Controller')) continue;

    const classAuthorises = classDecorators.some((d) => AUTHORISING_DECORATORS.has(d));

    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const names = decoratorNames(member);
      if (!names.some((d) => HTTP_DECORATORS.has(d))) continue;

      routesChecked += 1;
      if (classAuthorises || names.some((d) => AUTHORISING_DECORATORS.has(d))) continue;

      const { line } = source.getLineAndCharacterOfPosition(member.getStart(source));
      const method = ts.isIdentifier(member.name) ? member.name.text : '<computed>';
      const verb = names.find((d) => HTTP_DECORATORS.has(d));
      problems.push(
        `${file}:${line + 1}  ${statement.name?.text ?? '<anonymous>'}.${method}() ` +
          `is a @${verb}() route with no @Permission(), @Public() or @AuthenticatedOnly()`,
      );
    }
  }
}

// A check that silently finds nothing to check is the most dangerous kind: it
// passes forever and everyone believes the rule is enforced. This is the same
// failure the empty-`it.each` guard exists for.
if (files.length === 0) {
  process.stdout.write(`Permission-key check failed: no controllers found under ${ROOT}.\n`);
  process.exit(1);
}
if (routesChecked === 0) {
  process.stdout.write(
    `Permission-key check failed: ${files.length} controller file(s) parsed but zero routes recognised. ` +
      `The decorator names this script looks for have probably changed.\n`,
  );
  process.exit(1);
}

if (problems.length > 0) {
  process.stdout.write('Permission-key check failed (phase-00 §0.3):\n');
  for (const p of problems) process.stdout.write(`  - ${p}\n`);
  process.stdout.write(
    '\nEvery route is closed until it says otherwise. Add the permission key the route needs,\n' +
      'or @Public() if it is genuinely reachable without a session.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `Permission-key check passed: ${routesChecked} routes across ${files.length} controllers, all authorised.\n`,
);
