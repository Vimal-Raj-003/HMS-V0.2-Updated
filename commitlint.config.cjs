/**
 * Conventional commits, with the scope vocabulary from CLAUDE.md §4
 * (`feat(opd): ...`, `fix(billing): ...`, `db(lab): ...`).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'db', // migrations / schema / seeds
        'perf',
        'refactor',
        'test',
        'docs',
        'build',
        'ci',
        'chore',
        'revert',
        'security',
      ],
    ],
    'scope-empty': [2, 'never'],
    'subject-case': [2, 'never', ['upper-case', 'pascal-case', 'start-case']],
    'header-max-length': [2, 'always', 100],
  },
};
