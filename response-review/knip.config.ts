export default {
  entry: ['src/index.ts', 'web/app.ts', 'test/**/*.test.ts'],
  project: [
    'src/**/*.ts',
    'src/**/*.d.ts',
    'web/**/*.ts',
    'web/**/*.d.ts',
    'scripts/**/*.mjs',
    'test/**/*.test.ts',
  ],
};
