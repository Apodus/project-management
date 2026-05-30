import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// jest-dom ships a `declare module 'vitest'` augmentation, but because vitest
// re-exports its assertion types from `@vitest/expect` (rather than declaring
// them locally) that augmentation does not merge under moduleResolution:
// bundler. Augment the `@vitest/expect` `Matchers` extension point directly —
// `Assertion`/`AsymmetricMatchersContaining` both extend it — so the jest-dom
// matchers are visible to tsc.
declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merge augmentation
  interface Matchers<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
}
