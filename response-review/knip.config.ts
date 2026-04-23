export default {
  entry: ['src/index.ts', 'web/app.ts'],
  project: [
    'src/**/*.ts',
    'src/**/*.d.ts',
    'web/**/*.ts',
    'web/**/*.d.ts',
    'scripts/**/*.mjs',
  ],
  ignoreFiles: [
    'src/glimpseui.d.ts',
    'src/scripts-web-bundle.d.ts',
    'web/globals.d.ts',
  ],
};
