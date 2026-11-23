/**
 * The list: the cells the map draws, one row each, grouped by what each cell is doing.
 *
 * The five sections are the reading's own state-first split, and the scope arrives as a prop — the
 * same answer the map is given, so the two drawings are two projections of one set of cells rather
 * than two readings that could disagree. A row carries the cell's readings (its mark, its title,
 * the moment it speaks of, the lines it belongs to, its gate, what it still owes) and the two
 * presses it can answer: the session the cell was born in, and a fresh session for a cell that may
 * start.
 *
 * Nothing here computes a reading, and nothing here decides which line a session opens under: the
 * pane hands the row the line, and the row hands it back with the cell.
 */
import * as React from 'react'
import type { DetailGroupKey, GateReading, NodeReading, ProjectReading } from '../model/index.ts'
import { dispatchCycleOf, nodesOf, ownersOf } from '../model/index.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { gateTitle, gateWord, NODE_WORDS, timeOf, unit } from './words.ts'
import { nodeName, nodeHover } from './nodes.ts'
import { FoldSection } from './widgets.tsx'
import { DepsChip, StateMark } from './marks.tsx'
import type { NodeGo } from './map.tsx'

/**
 * The five sections, in the order readers meet them.
 *
 * `silences` names the gate kinds this section already says in its own head: the shelves section is
 * headed by the wait for a person, so a cell parked there wears no second badge. It is stated as a
 * mapping rather than as a comparison against the section's key, which is another vocabulary
 * (`shelved` / `run` / `ready` / `wait` / `done`) that happens to share one word with the gate kinds
 * (`shelved` / `manual` / `checkpoint`) — sharing a word is not sharing a fact.
 */
interface Group {
  readonly key: DetailGroupKey
  /** Which word heads this section, looked up when the header is drawn so the table knows no language. */
  readonly word: WordKey
  readonly cls: string
  readonly deps: boolean
  /** The gate kinds this section's own head already states; a cell gated that way adds no badge. */
  readonly silences: readonly GateReading['kind'][]
}

/* The five sections always start expanded: the rows are what the reader came to see, and the folding
 * move survives, triggered by the reader. The three sections that head a node state take their word
 * from the vocabulary layer's own table (`NODE_WORDS`); `run` and `ready` head line-level judgments,
 * which that table does not hold. */
const GROUPS: readonly Group[] = [
  { key: 'shelved', word: NODE_WORDS.shelved, cls: 'is-shelved', deps: false, silences: ['shelved'] },
  { key: 'run', word: 'state.running', cls: 'is-running', deps: false, silences: [] },
  { key: 'ready', word: 'state.ready', cls: 'is-todo', deps: false, silences: [] },
  { key: 'wait', word: NODE_WORDS.todo, cls: 'is-todo', deps: true, silences: [] },
  { key: 'done', word: NODE_WORDS.completed, cls: 'is-done', deps: false, silences: [] },
]

/**
 * The list itself, without the frame it stands in: the pane shell, the band and the switch between
 * the two drawings are the pane's (`board.tsx`).
 * @param props - The reading, whether this drawing is the one on screen, the scope the rows are
 *   filtered to, where a row's press goes, the stranded claims, the annotation of a row whose
 *   open-session write is in flight, and where that write goes.
 */
export function DetailBody(props: {
  readonly project: ProjectReading | null
  /** Whether this drawing is the one on screen; the other one is still mounted, and hidden. */
  readonly hidden: boolean
  /** The cells in scope: a line's id, or `null` for the whole workspace. */
  readonly scope: string | null
  readonly go: NodeGo | null
  /** The stranded dispatches, by node id: the line each cell's claim belongs to. */
  readonly stranded: Readonly<Record<string, string>>
  /** The cell whose open-session write is in flight; its own action stands disabled meanwhile. */
  readonly openingNode: string | null
  readonly onOpenNode: (nodeId: string, cycle: string) => void
}): React.ReactElement {
  const t = useT()
  const { project, scope } = props
  const cycle = project === null || scope === null ? null : (project.cycles.find((one) => one.id === scope) ?? null)
  return (
    <div className="superworker-scroll" role="region" aria-label={t('view.nodes')} tabIndex={0} hidden={props.hidden}>
      {project === null ? null : GROUPS.map((group) => {
        const list = nodesOf(group.key, cycle, project)
        if (list.length === 0) return null
        return (
          <DetailGroup
            key={group.key}
            group={group}
            nodes={list}
            at={project.at}
            scope={scope}
            go={props.go}
            stranded={props.stranded}
            openingNode={props.openingNode}
            onOpenNode={props.onOpenNode}
          />
        )
      })}
    </div>
  )
}

/** A section's header and the rows under it. */
function DetailGroup(props: {
  readonly group: Group
  readonly nodes: readonly NodeReading[]
  readonly at: Date
  readonly scope: string | null
  readonly go: NodeGo | null
  readonly stranded: Readonly<Record<string, string>>
  readonly openingNode: string | null
  readonly onOpenNode: (nodeId: string, cycle: string) => void
}): React.ReactElement {
  const { group } = props
  const t = useT()
  const [folded, setFolded] = React.useState(false)
  return (
    <FoldSection
      folded={folded}
      onToggle={() => setFolded((value) => !value)}
      title={t(group.word)}
      figs={folded ? (
        <React.Fragment>
          <b className="superworker-num">{props.nodes.length}</b>
          {unit(t, 'detail.folded.cells.one', 'detail.folded.cells.other', props.nodes.length)}
        </React.Fragment>
      ) : null}
      figsClass="superworker-rowcount"
    >
      {props.nodes.map((node) => (
        <Row
          key={node.id}
          node={node}
          group={group}
          at={props.at}
          scope={props.scope}
          go={props.go}
          stranded={props.stranded}
          openingNode={props.openingNode}
          onOpenNode={props.onOpenNode}
        />
      ))}
    </FoldSection>
  )
}

/**
 * One row: what the cell is doing, what it is called, and — at the row's right end — the moment and
 * every reading that qualifies it.
 *
 * The row is also the way into the cell's own conversation. A row whose cell has no session this
 * machine holds is not pressable and does not pretend to be: it takes no pointer cursor, no focus
 * and no role.
 */
function Row(props: {
  readonly node: NodeReading
  readonly group: Group
  readonly at: Date
  readonly scope: string | null
  readonly go: NodeGo | null
  readonly stranded: Readonly<Record<string, string>>
  readonly openingNode: string | null
  readonly onOpenNode: (nodeId: string, cycle: string) => void
}): React.ReactElement {
  const t = useT()
  const { node, group, at } = props
  const target = props.go === null ? null : props.go.targetOf(node)
  /* The line a fresh round opens under. Under one scope it is that line — every row on the page
   * belongs to it, the scope being a filter; over the whole workspace it is the last line that
   * walked the cell, and a cell no line has touched has none, so its row offers no action. */
  const cycle = props.scope ?? dispatchCycleOf(node)
  const owners = ownersOf(node)
  const moment = node.stampAt
  /* A gate this section's head already says adds no second word; every other one stands here. */
  const gate = node.gate !== null && !group.silences.includes(node.gate.kind) ? gateWord(t, node.gate) : null
  const hover = [gateTitle(t, node, at), target === null ? '' : t('board.row.go')].filter((one) => one.length > 0).join(' · ')
  const goTo = (): void => {
    if (target !== null) props.go?.open(target)
  }
  return (
    <div
      className={`superworker-row ${group.cls}`}
      data-id={node.id}
      role={target === null ? undefined : 'button'}
      tabIndex={target === null ? undefined : 0}
      title={hover.length === 0 ? undefined : hover}
      onClick={target === null ? undefined : goTo}
      onKeyDown={target === null ? undefined : (event) => {
        /* Only the row's own keys: a press on the action inside it is the action's. */
        if (event.target !== event.currentTarget) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        goTo()
      }}
    >
      <StateMark node={node} at={at} dead={props.stranded[node.id] ?? null} />
      <span className="superworker-rowtitle" title={nodeHover(node)}>{nodeName(node)}</span>
      <span className="superworker-rowfigs">
        {moment === null ? null : <span className="superworker-rowtime superworker-num">{timeOf(t, moment, at)}</span>}
        {/* Which lines the cell belongs to is printed only over the whole workspace: under one scope
            every row on the page would wear the same word. */}
        {props.scope !== null || owners.length === 0 ? null : <span className="superworker-mtag">{owners.join('·')}</span>}
        {gate === null ? null : <span className={`superworker-gate${node.state === 'todo' ? ' is-quiet' : ''}`}>{gate}</span>}
        {group.deps ? <DepsChip node={node} /> : null}
        {/* The one cell a session can be opened for is a ready one: the other sections say their own
            states and carry no action. While this cell's own open is in flight the action stands
            disabled until the write settles (settling takes the model minutes, and a second click
            would open a second session on the same cell). */}
        {group.key === 'ready' && cycle !== null ? (
          <button
            type="button"
            className="superworker-mini"
            disabled={props.openingNode === node.id}
            onClick={(event) => {
              event.stopPropagation()
              props.onOpenNode(node.id, cycle)
            }}
          >
            {t('node.open')}
          </button>
        ) : null}
      </span>
    </div>
  )
}
