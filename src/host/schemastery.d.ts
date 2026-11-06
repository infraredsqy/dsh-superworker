/**
 * Minimal declarations for `@deepseek-ai/schemastery`.
 *
 * The package is provided by the host; this repo neither installs it nor
 * keeps a copy: DSH's settings service rebuilds the schema we hand over with
 * its own schemastery (that JSON shape is what flows between the two sides),
 * so only the runtime-relevant handful of methods are declared here.
 */
declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    /** Run a raw value through this schema. */
    (value: unknown): T
    /** The node kind; the settings service branches objects and fields by it. */
    readonly type: string
    /** The node's own markers: `volatile` means "whether this entry shows in the settings page". */
    readonly meta: { volatile?: boolean; default?: unknown }
    /** The field table of an object node. */
    readonly dict: Readonly<Record<string, Schema>> | undefined
    /** The shape handed to the settings service. */
    toJSON(): unknown
    /**
     * Mark as editable live in the settings page.
     *
     * Optional on purpose: older builds (3.18.1 era) do not carry it, and a caller
     * must be able to test for it before calling. The two host shapes are stated here
     * once — the callers probe rather than assume.
     */
    volatile?(): Schema<T>
    default(value: T): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
  }

  export interface Schemastery {
    /** Rebuild a node from a serialized shape. */
    <T>(json: unknown): Schema<T>
    object(dict: Readonly<Record<string, Schema>>): Schema<Record<string, unknown>>
    boolean(): Schema<boolean>
    number(): Schema<number>
    /** The value must be one of these words. */
    union(values: readonly string[]): Schema<string>
  }

  const schemastery: Schemastery
  export default schemastery
}