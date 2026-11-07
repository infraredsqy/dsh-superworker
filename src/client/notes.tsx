/**
 * The third pane of the main panel: the instruction book. A "record one" row (scope picker plus
 * verbatim text) plus a ledger grouped by scope.
 *
 * The write side lives in the shell: adding, archiving, and reviving all go up through the
 * callbacks here, and whether the write landed is said by the callback's return value; delete only
 * hands the entry back to the shell — the confirm modal belongs to the shell. This pane never
 * touches the gateway itself.
 */
import * as React from 'react'
import type { InstructionScope } from '../host/gateway.ts'
import type { CycleReading, InstructionReading, NodeReading, ProjectReading } from '../model/index.ts'
import { dayParts, groupInstructions } from '../model/index.ts'
import type { Translate } from './locale.ts'
import { useT } from './locale.ts'
import { dayLabel, groupWord, timeOf, unit } from './words.ts'
import { nameWithin, nodeName } from './nodes.ts'
import { PaneFrame } from './widgets.tsx'

/** With archived entries collapsed, how many non-standing rows a group may show at most. */
const NOTES_ROWS = 5

/** How many characters the scope picker's cell-bound row can print before the name is cut. */
const SCOPE_NAME_WIDTH = 12

/**
 * The full layout of the notes pane: the "record one" row plus the ledger.
 * @param props - Visibility, whether to collapse to one sentence, the reading at this moment with
 *   the record's lines, the settings value for "show archived too", and where the add, archive,
 *   revive, and delete actions go.
 */
export function NotesPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  readonly project: ProjectReading | null
  readonly showArchived: boolean
  readonly onAdd: (text: string, scope: InstructionScope, cycle: string, node: string) => Promise<boolean>
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const t = useT()
  /* The record's lines come from the reading itself, not from a second prop carrying the same
   * state: the scope picker cannot list a line the ledger below was not read with. */
  const cycles = props.project?.cycles ?? []
  return (
    <PaneFrame id="notes" active={props.active} noNodes={props.noNodes} fill>
      {props.project === null ? null : (
        <InstructionAdd
          cycles={cycles}
          inHand={props.project.columns.running[0] ?? null}
          onAdd={props.onAdd}
        />
      )}
      <div className="superworker-scroll" id="notes-scroll" role="region" aria-label={t('notes.scroll.aria')} tabIndex={0}>
        {props.project === null ? null : (
          <InstructionBook
            project={props.project}
            showArchived={props.showArchived}
            onArchive={props.onArchive}
            onRevive={props.onRevive}
            onDelete={props.onDelete}
          />
        )}
      </div>
    </PaneFrame>
  )
}

/** The global entry's own scope value: first on the scope table, and where the picker starts. */
const GLOBAL_VALUE = 'global'

/** The three things the scope picker needs per entry: the scope word, which line, which cell. */
interface ScopeChoice {
  readonly value: string
  readonly label: string
  readonly scope: InstructionScope
  readonly cycle: string
  readonly node: string
}

/**
 * Which entries the scope column lists, and in which order: global, the record's lines, the cell
 * currently in hand.
 *
 * The cell in hand is not a fixed row: the record itself says which one it is, and when none is in
 * hand, the entry is absent.
 *
 * The global entry stands first, which is also what the picker falls back to when the previously
 * picked line is gone; its word, and the cell-bound entry's, are asked for here. A line's own id is a
 * record's word and is carried through as it stands.
 */
function scopeChoices(t: Translate, cycles: readonly CycleReading[], inHand: NodeReading | null): readonly ScopeChoice[] {
  const out: ScopeChoice[] = [{ value: GLOBAL_VALUE, label: t('common.global'), scope: 'global', cycle: '', node: '' }]
  for (const cycle of cycles) {
    out.push({ value: `cycle:${cycle.id}`, label: cycle.id, scope: 'cycle', cycle: cycle.id, node: '' })
  }
  if (inHand !== null) {
    /* The width this picker's column can print; how a name is cut is `nodes.ts`'s one answer. */
    const short = nameWithin(nodeName(inHand), SCOPE_NAME_WIDTH)
    out.push({ value: `node:${inHand.id}`, label: t('notes.scope.node', { node: short }), scope: 'node', cycle: '', node: inHand.id })
  }
  return out
}

/**
 * The "record one" row: scope picker + verbatim text, standing at the top of the pane.
 *
 * The sentence is cleared from the box only once the write lands: if the tool refuses, the user's
 * own words stay in place, ready to be revised.
 */
function InstructionAdd(props: {
  readonly cycles: readonly CycleReading[]
  readonly inHand: NodeReading | null
  readonly onAdd: (text: string, scope: InstructionScope, cycle: string, node: string) => Promise<boolean>
}): React.ReactElement {
  const t = useT()
  const [text, setText] = React.useState('')
  const [picked, setPicked] = React.useState(GLOBAL_VALUE)
  const box = React.useRef<HTMLInputElement | null>(null)
  const choices = scopeChoices(t, props.cycles, props.inHand)
  /* The previously picked entry may be gone from the record; the global entry always stands first. */
  const chosen = choices.find((one) => one.value === picked) ?? choices[0] as ScopeChoice

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const said = text.trim()
    if (said.length === 0) {
      box.current?.focus()
      return
    }
    void props.onAdd(said, chosen.scope, chosen.cycle, chosen.node).then((accepted) => {
      if (accepted) setText('')
    })
  }

  return (
    <form className="superworker-add" id="add" onSubmit={submit}>
      <span className="superworker-pick">
        <select
          aria-label={t('notes.scope.aria')}
          value={chosen.value}
          onChange={(event) => setPicked(event.target.value)}
        >
          {choices.map((one) => <option key={one.value} value={one.value}>{one.label}</option>)}
        </select>
      </span>
      <input
        ref={box}
        type="text"
        placeholder={t('notes.text.placeholder')}
        aria-label={t('notes.text.aria')}
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="superworker-btn">{t('notes.add')}</button>
    </form>
  )
}

/** The instructions cell: the ledger grouped by scope. */
function InstructionBook(props: {
  readonly project: ProjectReading
  readonly showArchived: boolean
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const t = useT()
  const { project } = props
  const [folded, setFolded] = React.useState<Readonly<Record<string, boolean>>>({})
  const [open, setOpen] = React.useState<Readonly<Record<string, boolean>>>({})

  /* Archived entries are collapsed by default: what still counts now is what a screen shows first.
   * Once the settings row is turned on, they return to their sections, the actions at the row's
   * right still usable. */
  const visible = props.showArchived
    ? project.instructions
    : project.instructions.filter((entry) => entry.standing)
  const groups = groupInstructions(project, visible)
  if (project.instructions.length === 0) {
    return <p className="superworker-innone">{t('notes.empty')}</p>
  }
  return (
    <React.Fragment>
      {groups.length === 0
        ? <p className="superworker-innone">{t('notes.empty-live')}</p>
        : groups.map((group) => {
          const live = group.entries.filter((entry) => entry.inForce).length
          const isFolded = folded[group.key] === true
          const isOpen = open[group.key] === true
          const hidden = Math.max(0, group.entries.length - live - NOTES_ROWS)
          const shown = isOpen ? group.entries : group.entries.slice(0, live + NOTES_ROWS)
          return (
            <section className={`superworker-sec${isFolded ? ' is-folded' : ''}`} key={group.key}>
              <button
                type="button"
                className="superworker-rowhead"
                aria-expanded={!isFolded}
                onClick={() => setFolded((table) => ({ ...table, [group.key]: !isFolded }))}
              >
                <span className="superworker-rowhead-key">{groupWord(t, group)}</span>
                <span className="superworker-rowhead-figs">
                  <b className="superworker-num">{live}</b>
                  {t('notes.in-force')}
                  <React.Fragment>{' · '}<b className="superworker-num">{group.entries.length}</b>{unit(t, 'notes.entries.one', 'notes.entries.other', group.entries.length)}</React.Fragment>
                </span>
              </button>
              {shown.map((entry) => (
                <InstructionRow
                  key={entry.id}
                  entry={entry}
                  at={project.at}
                  onArchive={props.onArchive}
                  onRevive={props.onRevive}
                  onDelete={props.onDelete}
                />
              ))}
              {hidden > 0 && !isOpen
                ? (
                  <button type="button" className="superworker-trim" onClick={() => setOpen((table) => ({ ...table, [group.key]: true }))}>
                    {t('common.expand-more', { count: hidden })}
                  </button>
                )
                : null}
              {hidden > 0 && isOpen
                ? (
                  <button type="button" className="superworker-trim" onClick={() => setOpen((table) => ({ ...table, [group.key]: false }))}>
                    {t('common.collapse')}
                  </button>
                )
                : null}
            </section>
          )
        })}
    </React.Fragment>
  )
}

function InstructionRow(props: {
  readonly entry: InstructionReading
  readonly at: Date
  readonly onArchive: (id: string) => void
  readonly onRevive: (id: string) => void
  readonly onDelete: (instruction: InstructionReading) => void
}): React.ReactElement {
  const t = useT()
  const { entry, at } = props
  const moment = entry.inForce ? entry.saidAt : (entry.closedAt ?? entry.saidAt)
  const mark = entry.inForce ? '' : entry.standing ? t('notes.out-of-scope') : t('notes.archived-mark')
  return (
    <article className={`superworker-ins${entry.inForce ? '' : ' is-out'}`} title={entry.nodeId ?? ''}>
      <div className="superworker-ins-text">{entry.text ?? ''}</div>
      <div className="superworker-ins-read" title={`${entry.inForce ? t('notes.said-at') : t('notes.said-mark', { mark })} ${timeOf(t, moment, at)}`}>
        {mark.length === 0 ? null : <span className="superworker-ins-mark">{mark}</span>}
        <span className="superworker-num">{dayLabel(t, dayParts(moment, at))}</span>
      </div>
      <span className="superworker-ins-acts">
        {entry.standing
          ? <button type="button" className="superworker-mini" title={t('notes.archive.tip')} onClick={() => props.onArchive(entry.id)}>{t('common.archive')}</button>
          : <button type="button" className="superworker-mini" title={t('notes.revive.tip')} onClick={() => props.onRevive(entry.id)}>{t('common.revive')}</button>}
        <button
          type="button"
          className="superworker-mini"
          title={t('notes.delete.tip')}
          onClick={() => props.onDelete(entry)}
        >
          {t('common.delete')}
        </button>
      </span>
      {entry.note === undefined ? null : (
        <div className="superworker-ins-foot"><span className="superworker-ins-note">{entry.note}</span></div>
      )}
    </article>
  )
}
