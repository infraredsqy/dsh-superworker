/**
 * The slow tier switch: the real-git-subprocess groups and the cross-process lock groups read it
 * through `describe.skipIf(!SLOW)` / `it.skipIf(!SLOW)`. The default run (`pnpm test`) leaves those
 * groups skipped; `SW_SLOW=1 pnpm test` is the one tier that runs them.
 */
export const SLOW = process.env.SW_SLOW === '1';
