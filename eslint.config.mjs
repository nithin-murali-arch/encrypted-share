import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaVersion: 2022 } },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['flat/recommended'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
];
