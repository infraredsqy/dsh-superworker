/**
 * The second pane of the main panel: detail. A line sidebar on the left (one pick button per line),
 * and the body is the picked line's node list grouped into five sections; a movable split sits
 * between sidebar and body.
 *
 * Picking a line and moving the split are both handed back to the shell (`onPickLine` /
 * `onSideWidth` / `onSideCommit`); writing back to the settings document is the shell's job. The
 * shell also says which cell's open-session write is in flight (`openingNode`): that cell's own
 * action stands disabled until the write settles.
 */
import * as React from 'react'
import type { CycleReading, DetailGroupKey, GateReading, NodeReading, ProjectReading } from '../model/index.ts'
import { nodesOf } from '../model/index.ts'
import { clampSide, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN } from './prefs.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { gateTitle, gateWord, stateWord, unit } from './words.ts'
import { nodeName, nodeHover } from './nodes.ts'
import { Grip, PaneFrame } from './widgets.tsx'
import { DepsChip, LineMark, StateMark } from './marks.tsx'

/**
 * The five detail sections, in the order readers meet them.
 *
 * `silences` names the gate kinds this section already says in its own head: the shelves section is
 * headed by the wait for a person, so a card parked there wears no second badge. It is stated as a
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
  /** The gate kinds this section's own head already states; a card gated that way adds no badge. */
  readonly silences: readonly GateReading['kind'][]
}

/* The five sections always start expanded: this pane is called detail, and the rows are what the
 * reader came to see. The folding move survives, triggered by the reader. */
const GROUPS: readonly Group[] = [
  { key: 'shelved', word: 'state.shelved', cls: 'is-shelved', deps: false, silences: ['shelved'] },
  { key: 'run', word: 'state.running', cls: 'is-running', deps: false, silences: [] },
  { key: 'ready', word: 'state.ready', cls: 'is-todo', deps: false, silences: [] },
  { key: 'wait', word: 'state.todo', cls: 'is-todo', deps: true, silences: [] },
  { key: 'done', word: 'state.done', cls: 'is-done', deps: false, silences: [] },
]

/** How far one keyboard move of the detail split travels; Shift takes two steps. */
const SPLIT_STEP = 16

/**
 * Which line is being shown: the one the reader picked, and the record's first line when nothing is
 * picked yet — or when the picked id no longer names a line, as happens when a re-read drops it.
 *
 * The resolution is written here once and read by both ends that need it: the pane that lists a
 * line's cells and the shell that opens a session for one of them. Two copies of this expression
 * would be free to name different lines, and the body would list one line while "open" reported
 * another.
 */
export function pickedCycleOf(cycles: readonly CycleReading[], lineId: string | null): CycleReading | null {
  return cycles.find((cycle) => cycle.id === lineId) ?? cycles[0] ?? null
}

/**
 * The full layout of the detail pane: the line sidebar, the split, and the body.
 * @param props - Visibility, whether to collapse to one sentence, which line is picked (and the record's
 *   reading it is resolved in), the split width with its two write-backs, where the pick-line action
 *   goes, and where the open-a-session action on a ready cell goes.
 */
export function DetailPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  /** Which line the reader picked; `null` before anything is picked, read as the record's first line. */
  readonly lineId: string | null
  readonly project: ProjectReading | null
  /** The stranded dispatches, by node id: the line each cell's claim belongs to. */
  readonly stranded: Readonly<Record<string, string>>
  readonly sideWidth: number
  readonly onSideWidth: (px: number) => void
  readonly onSideCommit: (px: number) => void
  readonly onPickLine: (id: string) => void
  readonly onOpenNode: (nodeId: string) => void
  /** The cell whose open-session write is in flight; its own action stands disabled meanwhile. */
  readonly openingNode: string | null
}): React.ReactElement {
  const t = useT()
  /* The record's lines come from the reading itself, and which of them is picked is resolved by
   * {@link pickedCycleOf} from the reading and the picked id: the pane holds one entry to the state
   * it draws, so the sidebar and the body cannot be a frame apart, and no line object comes in
   * beside the record. */
  const cycles = props.project?.cycles ?? []
  const picked = pickedCycleOf(cycles, props.lineId)
  return (
    <PaneFrame id="detail" active={props.active} noNodes={props.noNodes} fill>
      <div className="superworker-detail" style={{ ['--superworker-side-w' as string]: `${props.sideWidth}px` }}>
        <div className="superworker-lineside" role="group" aria-label={t('detail.lines.aria')}>
          {cycles.map((cycle) => (
            <div className="superworker-lineitem" key={cycle.id}>
              <button
                type="button"
                className="superworker-linepick"
                aria-current={cycle.id === picked?.id}
                aria-label={`${cycle.id} · ${stateWord(t, cycle)}`}
                onClick={() => props.onPickLine(cycle.id)}
              >
                <LineMark cycle={cycle} />
                <span className="superworker-cycle">{cycle.id}</span>
              </button>
            </div>
          ))}
        </div>
        {/* The split between sidebar and body: one edge moving Δ measures this column's width. */}
        <Grip
          id="detail-split"
          label={t('detail.side-grip.aria')}
          value={props.sideWidth}
          min={SIDE_MIN}
          max={SIDE_MAX}
          clamp={clampSide}
          step={SPLIT_STEP}
          onChange={props.onSideWidth}
          onCommit={props.onSideCommit}
          resetTo={SIDE_DEFAULT}
        />
        <div className="superworker-linemain">
          <div className="superworker-scroll" role="region" aria-label={t('view.detail')} tabIndex={0}>
            {picked === null || props.project === null ? null : <DetailList cycle={picked} project={props.project} stranded={props.stranded} onOpenNode={props.onOpenNode} openingNode={props.openingNode} />}
          </div>
        </div>
      </div>
    </PaneFrame>
  )
}

/** Detail: the picked line's node list, grouped into five sections. */
function DetailList(props: { readonly cycle: CycleReading; readonly project: ProjectReading; readonly stranded: Readonly<Record<string, string>>; readonly onOpenNode: (nodeId: string) => void; readonly openingNode: string | null }): React.ReactElement {
  const { cycle, project } = props
  const at = project.at
  return (
    <React.Fragment>
      {GROUPS.map((group) => {
        const list = nodesOf(group.key, cycle, project)
        if (list.length === 0) return null
        return <DetailGroup key={group.key} group={group} nodes={list} at={at} stranded={props.stranded} onOpenNode={props.onOpenNode} openingNode={props.openingNode} />
      })}
    </React.Fragment>
  )
}

/** A section's header and the rows under it. */
function DetailGroup(props: { readonly group: Group; readonly nodes: readonly NodeReading[]; readonly at: Date; readonly stranded: Readonly<Record<string, string>>; readonly onOpenNode: (nodeId: string) => void; readonly openingNode: string | null }): React.ReactElement {
  const { group } = props
  const t = useT()
  const [folded, setFolded] = React.useState(false)
  return (
    <section className={`superworker-sec${folded ? ' is-folded' : ''}`}>
      <button
        type="button"
        className="superworker-rowhead"
        aria-expanded={!folded}
        onClick={() => setFolded((value) => !value)}
      >
        <span className="superworker-rowhead-key">{t(group.word)}</span>
        {folded
          ? <span className="superworker-rowhead-figs superworker-rowcount"><b className="superworker-num">{props.nodes.length}</b>{unit(t, 'detail.folded.cells.one', 'detail.folded.cells.other', props.nodes.length)}</span>
          : null}
      </button>
      {props.nodes.map((node) => (
        <div className={`superworker-row ${group.cls}`} key={node.id} data-id={node.id} title={gateTitle(t, node, props.at)}>
          <StateMark node={node} at={props.at} dead={props.stranded[node.id] ?? null} />
          <span className="superworker-rowtitle" title={nodeHover(node)}>{nodeName(node)}</span>
          <span className="superworker-rowfigs">
            {group.deps ? <DepsChip node={node} /> : null}
            {/* The one cell a session can be opened for is a ready one: the other sections say their
                own states and carry no action. The figs column is the row's own room for it — ready
                rows owe nothing, so the cell stands empty until this action fills it. While this
                cell's own open is in flight the action stands disabled until the write settles
                (settling takes the model minutes, and a second click would open a second session
                on the same cell). */}
            {group.key === 'ready' ? (
              <button type="button" className="superworker-mini" disabled={props.openingNode === node.id} onClick={() => props.onOpenNode(node.id)}>{t('node.open')}</button>
            ) : null}
          </span>
          {/* The section already says its own gate kind: a node gated that same way adds no second
              badge here. Both sides are the structured kind — a gate's kind against the kinds this
              section silences. */}
          {node.gate !== null && !group.silences.includes(node.gate.kind)
            ? <span className={`superworker-gate superworker-rowgate${node.state === 'todo' ? ' is-quiet' : ''}`}>{gateWord(t, node.gate)}</span>
            : null}
        </div>
      ))}
    </section>
  )
}
