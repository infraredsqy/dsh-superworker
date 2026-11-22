/**
 * Reading widgets shared by the detail rows, the instruction book, the map's cards, and the two line
 * columns: a state mark, a line's own mark, and a dependency line.
 *
 * These readings exist only once: the state mark on the map's cards and on detail rows is the same
 * one, a line's mark is the same cell in the map's rail and in the detail pane's column, and the
 * dependency line wears the same face — each cell just passes its own cell and moment. The words
 * themselves (a gate's hint, a moment's day, a line's state) are spelled in `words.ts`.
 */
import * as React from 'react'
import type { CycleReading, CycleState, NodeReading } from '../model/index.ts'
import { bucketOf, lineStateOf, readDeps } from '../model/index.ts'
import type { Translate } from './locale.ts'
import { useT } from './locale.ts'
import { depsSentence, elapsedOf, gateTitle, stateWord, strandedTitle } from './words.ts'

/**
 * What each line state wears on the mark: the same answer that spells the hover sentence
 * ({@link stateWord}), so the spinner and the word cannot disagree.
 */
const LINE_CLASSES: Readonly<Record<CycleState, string>> = {
  blocked: 'is-blocked',
  run: 'is-run',
  stopped: '',
}

/**
 * What the running ring says: how long this step has been open, or just "in hand" when the line
 * claimed a step that has not opened yet. One sentence, because the ring is one drawing — the
 * detail rows and the map's own card both stand it up.
 */
export function runningTitle(t: Translate, node: NodeReading): string {
  return node.elapsedSeconds === null ? t('state.running') : t('marks.running.elapsed', { elapsed: elapsedOf(t, node.elapsedSeconds) })
}

/**
 * A line's own mark, the cell left of a line name: parked and idle when stopped, spinning while
 * running, drawn as blocked when it owes waiting nodes.
 *
 * The two left columns stand this one drawing up, so a line reads the same on the map's rail and in
 * the detail pane's column — whichever workspace the panel has open, this is the line's own state in
 * the record rather than a reading of the page.
 */
export function LineMark(props: { readonly cycle: CycleReading }): React.ReactElement {
  const t = useT()
  const { cycle } = props
  const cls = LINE_CLASSES[lineStateOf(cycle)]
  return <span className={`superworker-linemark ${cls}`.trim()} title={stateWord(t, cycle)} />
}

/**
 * The three verdict glyphs, each path drawn once and shared: the check for work handed in, the two
 * bars for a word owed to a person, and the failed circle for a break. The stroke and the size are
 * the caller's — the detail rows stand them small and heavy ({@link StateMark}), the overview's
 * seal large and light, its fault lines light — so one module is what makes the detail rows'
 * mark and the overview's the same one, and what keeps the two files' drawings from drifting apart
 * again.
 */
export function CheckGlyph(props: { readonly stroke: number; readonly size?: number | undefined }): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" width={props.size} height={props.size} aria-hidden="true">
      <path d="M2.5 6.5l2.4 2.4 4.6-5.4" fill="none" stroke="currentColor" strokeWidth={props.stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The pause: two bars, not a circle — the turning ring already means "still moving", so the two are told apart by shape alone, at a glance. */
export function PauseGlyph(props: { readonly stroke: number; readonly size?: number | undefined }): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" width={props.size} height={props.size} aria-hidden="true">
      <path d="M4.6 2.6v6.8M7.4 2.6v6.8" fill="none" stroke="currentColor" strokeWidth={props.stroke} strokeLinecap="round" />
    </svg>
  )
}

/** The failed circle: the drawing a failed row wears, and the one a broken window's fault line stands up — a reader who met it in a feed meets it again on the band with the same meaning. */
export function FaultGlyph(props: { readonly stroke: number; readonly size?: number | undefined }): React.ReactElement {
  return (
    <svg viewBox="0 0 12 12" width={props.size} height={props.size} aria-hidden="true">
      <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth={props.stroke} />
      <path d="M6 3.8v2.8" fill="none" stroke="currentColor" strokeWidth={props.stroke} strokeLinecap="round" />
      <circle cx="6" cy="8.2" r="0.9" fill="currentColor" />
    </svg>
  )
}

/**
 * State mark: the model's one bucket, drawn. A detail row that wants a person (a gate, or the
 * shelved verdict, which is its own gate) takes the pause mark; the line's hold takes the spinner;
 * the row's own state draws the rest. Nothing here judges the record again. A stranded dispatch
 * outranks the bucket — the round is out and nothing is moving it, which is a wait no other
 * reading can say.
 */
export function StateMark(props: { readonly node: NodeReading; readonly at: Date; readonly dead?: string | null }): React.ReactElement {
  /* The mark's hover text is the only thing it says, so the translator is taken here, where the word
   * is printed. */
  const t = useT()
  const { node } = props
  if (props.dead !== undefined && props.dead !== null && props.dead.length > 0) {
    return <StrandedMark cycleId={props.dead} nodeId={node.id} />
  }
  const bucket = bucketOf(node)
  if (bucket === 'gate' || bucket === 'shelved') {
    return (
      <span className="superworker-state is-gate" title={gateTitle(t, node, props.at)}>
        <PauseGlyph stroke={1.7} size={12} />
      </span>
    )
  }
  if (bucket === 'run') {
    return <span className="superworker-state is-run" title={runningTitle(t, node)} />
  }
  if (bucket === 'todo') {
    return <span className="superworker-state is-next" title={t('state.next')} />
  }
  return (
    <span className="superworker-state is-done" title={t('state.done')}>
      <CheckGlyph stroke={1.6} size={12} />
    </span>
  )
}

/**
 * The stranded dispatch's own mark: the failed mark's ring, worn in the amber this
 * panel reserves for "a person has to move". Its hover carries the remedy — one
 * sentence with the line's id, the cell's id and the two commands in it. The same
 * drawing stands on the map's card and on the detail row.
 */
export function StrandedMark(props: { readonly cycleId: string; readonly nodeId: string }): React.ReactElement {
  const t = useT()
  return <span className="superworker-state is-dead" title={strandedTitle(t, props.cycleId, props.nodeId)} />
}

/**
 * The dependency line, wearing the same face in every view: ready to start, or N prerequisite nodes.
 *
 * Whether a cell owes an answer at all is the reading's decision (`readDeps`); how that answer is
 * worded is this panel's (`depsSentence`). The sentence arrives already split around its number, so
 * the number gets its own mark styling (monospace, brighter) without cutting a finished sentence in
 * two — a language is free to put the number first, and one of them does.
 */
export function DepsChip(props: { readonly node: NodeReading }): React.ReactElement | null {
  const t = useT()
  const deps = readDeps(props.node)
  if (deps === null) return null
  const said = depsSentence(t, deps)
  return (
    <span className={`superworker-deps${deps.ready ? ' is-ready' : ''}`}>
      {said.head}
      {said.count === null ? null : <b className="superworker-num">{String(said.count)}</b>}
      {said.tail}
    </span>
  )
}
