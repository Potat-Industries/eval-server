export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // nice number smile (emote)
    'header-max-length': [2, 'always', 64],
    'body-max-line-length': [2, 'always', 72],
    // including a custom type "impr".
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'impr',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
};
