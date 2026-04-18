declare module '../scripts/web-bundle.mjs' {
  export interface ResponseReviewWebBundlePaths {
    repoRoot: string;
    sourcePath: string;
    outputPath: string;
  }

  export interface EnsureResponseReviewWebBundleOptions {
    rebuildIfStale?: boolean;
  }

  export function getResponseReviewWebBundlePaths(): ResponseReviewWebBundlePaths;
  export function transpileResponseReviewWebSource(source: string): string;
  export function buildResponseReviewWebBundle(): ResponseReviewWebBundlePaths;
  export function ensureResponseReviewWebBundle(
    options?: EnsureResponseReviewWebBundleOptions,
  ): ResponseReviewWebBundlePaths;
}
