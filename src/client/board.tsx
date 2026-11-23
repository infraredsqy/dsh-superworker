/**
 * The node page: one reading, two drawings, and the band that says which cells and which drawing.
 *
 * The scope is a filter over the record's cells — "the whole workspace" is that filter with nothing
 * taken out — and both drawings are handed the same answer, so the map and the list can never show
 * two different sets of cells. Which drawing stands in front is the reader's pick and is remembered
 * in the settings document (`nodeMode`), the way the tab is; which scope they are looking at is this
 * page's own state and goes away with it.
 *
 * Both drawings stay mounted while the page stands: the map's camera, the list's folds and its
 * scroll are the reader's place on the page, and a switch to the other drawing is a look at the same
 * cells from the other side, not a fresh arrival.
 */
import * as React from 'react'
import type { ProjectReading } from '../model/index.ts'
import { belongsTo } from '../model/index.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { NODE_MODES, type NodeMode } from './prefs.ts'
import { PaneFrame } from './widgets.tsx'
import { MapBody, type NodeGo } from './map.tsx'
import { DetailBody } from './detail.tsx'

/** What each drawing is called, as a key rather than as a word: the control draws it when it draws. */
const MODE_WORDS: Readonly<Record<NodeMode, WordKey>> = {
  map: 'board.mode.map',
  detail: 'board.mode.detail',
}

/**
 * The page's shell: the band over both drawings, and the two drawings themselves.
 * @param props - Visibility, whether the workspace has any cell at all, the reading, which drawing is
 *   in front (and where a pick is written back), where a cell's press goes, the stranded claims, the
 *   refresh, and the open-session action with the cell whose write is in flight.
 */
export function BoardPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  readonly project: ProjectReading | null
  /** Which drawing stands in front. */
  readonly mode: NodeMode
  readonly onMode: (mode: NodeMode) => void
  readonly go: NodeGo | null
  /** The stranded dispatches, by node id: the line each cell's claim belongs to. */
  readonly stranded: Readonly<Record<string, string>>
  readonly onRefresh: () => void
  /** The cell whose open-session write is in flight; its own action stands disabled meanwhile. */
  readonly openingNode: string | null
  /** Open a session for a ready cell under the line the row resolved. */
  readonly onOpenNode: (nodeId: string, cycle: string) => void
}): React.ReactElement {
  const t = useT()
  const [scope, setScope] = React.useState<string | null>(null)
  const project = props.project
  /* A scope the record no longer has (the line was deleted elsewhere) reads as the whole workspace
   * rather than as nothing: the control no longer offers it either. */
  const live = scope !== null && project !== null && project.cycles.some((cycle) => cycle.id === scope)
    ? scope
    : null
  const nodes = project?.nodes ?? []
  return (
    <PaneFrame id="nodes" active={props.active} noNodes={props.noNodes} className="superworker-board">
      <section className="superworker-band">
        {/* The scope control is the workspace selector's own object: a native list, wearing this
            panel's picker dress. Its rows are the record's lines by their own names — a line is a
            line, and the control says nothing about what it is doing. */}
        <span className="superworker-pick">
          <select
            id="node-scope"
            aria-label={t('board.scope.aria')}
            value={live ?? ''}
            onChange={(event) => setScope(event.target.value.length === 0 ? null : event.target.value)}
          >
            <option value="">{t('common.global')}</option>
            {(project?.cycles ?? []).map((cycle) => (
              <option
                key={cycle.id}
                value={cycle.id}
                /* A line that has touched nothing in this workspace holds no press and is drawn
                   greyed: the row itself is the reading — this line has done nothing here. */
                disabled={!nodes.some((node) => belongsTo(node, cycle.id))}
              >
                {cycle.id}
              </option>
            ))}
          </select>
        </span>
        {/* The two drawings, as the issue page's segmented control says its own two levels: one of
            them in play, both named. */}
        <div className="superworker-seg" role="group" aria-label={t('board.mode.aria')}>
          {NODE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="superworker-segbtn"
              id={`node-mode-${mode}`}
              aria-pressed={props.mode === mode}
              onClick={() => props.onMode(mode)}
            >
              {t(MODE_WORDS[mode])}
            </button>
          ))}
        </div>
      </section>

      {/* The map measures its own viewport, and a hidden pane measures zero: it is measured while it
          is the drawing in front, and again each time a resize lands. */}
      <MapBody
        active={props.active && props.mode === 'map'}
        hidden={props.mode !== 'map'}
        project={project}
        go={props.go}
        stranded={props.stranded}
        onRefresh={props.onRefresh}
        scope={live}
      />
      <DetailBody
        project={project}
        hidden={props.mode !== 'detail'}
        scope={live}
        go={props.go}
        stranded={props.stranded}
        openingNode={props.openingNode}
        onOpenNode={props.onOpenNode}
      />
    </PaneFrame>
  )
}
