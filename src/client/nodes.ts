/**
 * A cell's name and handle: the panel's cards and rows and the dependency cell's marks and cards
 * consume the same reading and print the same names.
 *
 * Cutting a name to fit is stated here and nowhere else: a second call site that decides its own
 * width and its own tail is a second answer to "what is this cell called".
 */
import type { NodeReading } from '../model/index.ts'

/** The width a cell's identity is cut to wherever only the handle is asked for. */
const ID_WIDTH = 8

/** The handle: a long identity keeps its first eight characters, and no ellipsis is added (the rest is not a word). */
export function shortId(id: string): string {
  return id.length > ID_WIDTH ? id.slice(0, ID_WIDTH) : id
}

/** A name cut to `width` characters, the ellipsis saying the rest was not printed. */
export function nameWithin(name: string, width: number): string {
  return name.length > width ? `${name.slice(0, width)}…` : name
}

/** A cell's title: the record's title; the short id only for cells whose record has no title. */
export function nodeName(node: NodeReading): string {
  return node.title ?? shortId(node.id)
}

/** A cell's hover text: full name followed by the 8-char handle; skipped when the name is that handle. */
export function nodeHover(node: NodeReading): string {
  const short = shortId(node.id)
  return node.title === undefined || node.title === short ? nodeName(node) : `${node.title} · ${short}`
}
