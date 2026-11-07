/**
 * Self-contained type declarations for the Node built-in surface.
 *
 * This package pulls in no third-party type package: devDependencies may only be
 * typescript / tsdown / vitest (a hard boundary the guard test pins),
 * and tsc only scans src/, so every node built-in surface src uses is declared here as a
 * minimal subset. The shapes follow the corresponding signatures of Node's official
 * @types/node, never more; to use a new built-in surface, declare it here first — no
 * package pulled in, no devDeps changed.
 *
 * This is the companion move under the "zero runtime dependencies" boundary: the runtime
 * carries these built-ins anyway, this only reports the small block of names src/ uses so
 * that tsc recognises them.
 */

declare var process: {
  readonly platform: string;
  /** The process id of this process (the body of the dispatch marker carries it). */
  readonly pid: number;
  /** The argv of the one process entry: `[node, the script, ...git's four arguments]`. */
  readonly argv: string[];
  /** The process environment: where `PATH` / `PATHEXT` are read (does the driver resolve by name?). */
  readonly env: { readonly [name: string]: string | undefined };
  /** The node executable running now: the absolute form of the merge-driver command is built from it. */
  readonly execPath: string;
  /** The monotonic clock (a nanosecond reading against an arbitrary anchor): the microsecond timestamp tail is filled in from here. */
  readonly hrtime: {
    bigint(): bigint;
  };
  /** The two exits of the verdict: decisions and usage errors. */
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
  /** The words layer's `-o -`: one handoff body read to the end of the stream. */
  readonly stdin: {
    setEncoding(encoding: 'utf8'): void;
    on(event: 'data', listener: (chunk: string) => void): void;
    on(event: 'end', listener: () => void): void;
  };
  /** The current working directory (the record tree of the merge driver lands in the driver process's cwd by default). */
  cwd(): string;
  /** Leave with this exit code (git reads it as the merge verdict); the call does not return. */
  exit(code: number): never;
};

declare var TextEncoder: {
  new (): { encode(input: string): Uint8Array };
};

declare var TextDecoder: {
  new (
    encoding?: string,
    options?: { fatal?: boolean; ignoreBOM?: boolean },
  ): { decode(input: Uint8Array): string };
};

declare function setTimeout(handler: () => void, timeoutMs: number): unknown;
/** Give up the waiting of one timer (doctor stops waiting on a git question that outlived its bound). */
declare function clearTimeout(handle: unknown): void;

declare module 'node:async_hooks' {
  /**
   * A read-only store bound to one async extent and its descendants: the ledger lock keeps the
   * resolved lock path it holds here, and a call that reads its own key back is a re-entry.
   */
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}

declare module 'node:path' {
  export function join(...segments: string[]): string;
  export function resolve(...segments: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export const sep: string;
  /** The separator between the entries of `PATH`. */
  export const delimiter: string;
}

declare module 'node:fs/promises' {
  export interface FileHandle {
    writeFile(data: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<FileHandle>;
  }
  export function open(path: string, flags: string): Promise<FileHandle>;
  export function readFile(path: string): Promise<Uint8Array>;
  /** The same read as text: an exclude file, a plugin's own text (the code page never enters here, it is UTF-8). */
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function rename(from: string, to: string): Promise<void>;
  export function unlink(path: string): Promise<void>;
  export function mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  /** Remove a whole directory (or one file) (used to clean temp/; `force` accepts "not there all along"). */
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options: { recursive: true }): string | undefined;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function rmSync(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): void;
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
    /** The modification time (milliseconds): comparing the ages of two handoff tickets uses it. */
    readonly mtimeMs: number;
    /** The byte count of the file (cleaning reports a size for each temp/). */
    readonly size: number;
  }
  export function statSync(path: string): Stats;
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: 'utf8' } | 'utf8',
  ): void;
  /** One entry of a directory listing: the name plus what it is (scanning a plugin directory only accepts directory entries). */
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  /** Make a throwaway temporary directory root (engine operations all happen in temporary directories). */
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:crypto' {
  /** A version 4 node id in the RFC 4122 shape; same shape as uuid4. */
  export function randomUUID(): string;
}

declare module 'node:os' {
  /** The user home directory of this machine (the default home of the machine-layer setting `<home>/.superworker/config.json`). */
  export function homedir(): string;
  /** The system temporary directory (stand-in projects and doctor's real question are both set up under it). */
  export function tmpdir(): string;
}

declare module 'node:url' {
  /** Turn a local path into an importable file URL (used to load a plugin implementation entry by path). */
  export function pathToFileURL(path: string): { href: string };
  /** Turn this module's own URL into a path (the absolute form of the merge-driver command names its product that way). */
  export function fileURLToPath(url: string): string;
}

interface ImportMeta {
  /** This module's own URL at run time: the built product of this package sits beside it. */
  readonly url: string;
}
