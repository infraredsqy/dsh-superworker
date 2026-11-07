/**
 * The sixth pane of the main panel: this workspace's own project settings.
 *
 * Two objects, side by side: an index down the left edge naming one category per line (with how many
 * rows each holds), and the page the rows stand on. A row is the key's name over its one sentence,
 * the value at the right, and a small tag saying which layer the value lives on. The page is read in
 * two columns while it can hold them and one full-width column when it cannot — the width decides
 * that, not the window, so a narrow panel is not left with a stranded column.
 *
 * Both reading and writing go through the tool: which keys exist, the valid values, and "which
 * layer a value comes from" are all printed by the tool; row order and category follow this side's
 * table, and writes land on this project's layer. This layer makes no second set of judgments — the
 * tool says whether keys and values are valid. No optimistic updates on the page: controls always
 * show the most recently read-back reading; a change is written, then read again, and when the tool
 * refuses, the control returns to its place on its own.
 */
import * as React from 'react'
import type { ConfigEntry, SuperworkerConfigReading } from '../host/project-config.ts'
import {
  configSectionsOf,
  GROUP_WORDS,
  LAYER_WORDS,
  pickState,
  rowWords,
  type ConfigGroup,
  type ConfigRow,
  type ConfigSection,
} from './config-rows.ts'
import type { PanelPort } from './data.ts'
import { failureOf } from './failure.ts'
import { useT } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import type { Load as LoadOf, Note } from './outcome.ts'
import { writeToNote } from './outcome.ts'
import { CommitNumberInput, PaneFrame } from './widgets.tsx'

/** The two words of the on / off control, as keys; the pressed one states the value the tool holds. */
const SIDES: readonly (readonly [WordKey, boolean])[] = [['config.toggle.on', true], ['config.toggle.off', false]]

/** How far this pane's own read has got; the shape is the client's one reading-of-a-read. */
type Load = LoadOf<SuperworkerConfigReading>

/**
 * How tall the page's own content stands, the tail left out: the last section's bottom measured in
 * the page's own coordinates, plus the page's bottom padding. The tail's own child is skipped, so
 * the answer stays the same however much room a jump has already asked for.
 *
 * `scrollHeight` cannot answer this while the rows are shorter than the scrollport — it stops at the
 * scrollport's own height, which is the very case the tail exists for.
 */
function contentHeight(box: HTMLDivElement): number {
  const standing = Array.from(box.children).filter((node) => !node.classList.contains('superworker-cfgtail'))
  const last = standing[standing.length - 1]
  if (last === undefined) return 0
  const bottom = last.getBoundingClientRect().bottom - box.getBoundingClientRect().top + box.scrollTop
  const padding = Number.parseFloat(getComputedStyle(box).paddingBottom)
  return bottom + (Number.isNaN(padding) ? 0 : padding)
}

export interface ConfigPaneProps {
  readonly port: PanelPort
  /** Session identity: the workspace file gateway resolves paths by it. */
  readonly sessionId: string
  /** Which workspace to read and write: the root picked at the top of the panel; an empty string means this session's own. */
  readonly workspaceRoot: string
  /** This workspace has no node record yet: the pane collapses to one sentence and the read command is not even started. */
  readonly noNodes: boolean
  /** Whether this pane is visible right now: the read happens only on the pass it becomes visible. */
  readonly active: boolean
  /** The note line at the bottom of the panel: what this pane has to say, or `null` to take back the last note it left. */
  readonly onNote: (note: Note | null) => void
}

export function ConfigPane(props: ConfigPaneProps): React.ReactElement {
  const { port, sessionId, workspaceRoot, noNodes, active } = props
  /* Every word this pane prints comes from here; the translator reads the active language at call
   * time, so a redraw after a language switch says the new one. */
  const t = useT()
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [tick, setTick] = React.useState(0)
  /* Which category the index is pointing at. `null` until the reader picks one or scrolls: the
     first category is the answer then, so a reading arriving later does not have to be written to
     this state from an effect. */
  const [at, setAt] = React.useState<ConfigGroup | null>(null)
  const page = React.useRef<HTMLDivElement>(null)
  /* The page's own tail, in pixels: the room a jump needs past the range the rows already leave.
     Rows that leave no range at all are the ordinary case here (three short categories all on
     screen), and the browser would clamp the jump back to nothing; the page grows this much tail
     on demand. It draws nothing and reads as nothing — the scroll range is all it carries. */
  const [tail, setTail] = React.useState(0)
  /* The scroll a jump owes: filled by the click, spent once the room above has landed in the layout. */
  const owed = React.useRef<number | null>(null)
  /* Jumps are counted, so two clicks that need the very same room still move the page: writing an
     equal number into the state is passed over, and the owed scroll would never leave. */
  const [jumps, setJumps] = React.useState(0)
  /* A jump moves the page itself, and the browser reports that move as a scroll like any other. This
     flag swallows that one report so the index does not wander back to the category the reader just
     left; the line they clicked keeps the light. */
  const jumped = React.useRef(false)
  /* Who left the last note on the note line: a failed read's note is retracted by the next
     successful read; a failed write's by the next successful write. A note left by other parts
     of the panel is not touched by this pane. */
  const said = React.useRef<'read' | 'write' | null>(null)
  const speak = React.useRef(props.onNote)
  React.useEffect(() => { speak.current = props.onNote }, [props.onNote])
  const note = React.useCallback((next: Note | null): void => {
    speak.current(next)
  }, [])

  /* Read only while this pane is actually visible: one read costs a tool command, and panes nobody
   * is looking at need not spend it.
   *
   * A successful read retracts only the previous failed-read note; the failed-write note is the
   * write's own business — otherwise every refused write would be wiped away on the spot by the
   * re-read that follows, and the reader would see nothing. */
  React.useEffect(() => {
    if (noNodes || !active || sessionId.length === 0) return undefined
    let live = true
    port.readConfig(sessionId, workspaceRoot).then(
      (reading) => {
        if (!live) return
        setLoad({ phase: 'ok', reading })
        if (reading.ok) {
          if (said.current === 'read') {
            said.current = null
            note(null)
          }
        } else {
          said.current = 'read'
          /* The tool's run failed: why is a code, spelled by the shell when the note line is drawn.
           * A refusal carrying nothing at all still reads as "the settings could not be read". */
          note({ kind: 'failure', failure: reading.refusal ?? { code: 'config-unreadable' } })
        }
      },
      (error: unknown) => {
        if (!live) return
        setLoad({ phase: 'failed', failure: failureOf(error) })
      },
    )
    return () => { live = false }
  }, [noNodes, active, sessionId, workspaceRoot, port, tick, note])

  /* One write: the tool's word is final, then read again — what controls show always follows the
     re-read copy. No key filtering: unregistered keys are passed through as well, and when the
     tool does not recognize one, its refusal lands on the note line. The loop is the shell's own
     (`writeToNote`); what is this pane's is who owns the note and that a re-read follows either
     way. */
  const send = React.useCallback((key: string, next: string): void => {
    void writeToNote(() => port.setConfig(sessionId, workspaceRoot, key, next), {
      note: (left) => {
        said.current = left?.kind === 'failure' ? 'write' : null
        note(left)
      },
      after: () => { setTick((round) => round + 1) },
    })
  }, [port, sessionId, workspaceRoot, note])

  const reading = load.phase === 'ok' ? load.reading : null
  const sections = reading === null ? [] : configSectionsOf(reading.entries)
  /* The index points at the picked category while it still has rows; otherwise at the first one. */
  const pointed = at === null ? sections[0]?.group : sections.find((section) => section.group === at)?.group

  /* A line in the index: bring that category's head to the page's own top — the height the first
     head rests on with the page unscrolled — so the first category asks for nothing and the reader
     who has come back up can always come home. Measured off the two rectangles rather than
     `offsetTop`, so the pane's own padding cannot put the head under the page's edge, and measured
     afresh on every click: a resize between two clicks changes nothing but the numbers.
     Rows shorter than the scrollport are the ordinary case here (three short categories all on
     screen), and a page with nothing to scroll has no range for the write at all. A jump needs a
     whole scrollport standing below its head, so the tail is what that misses from the content the
     page already has; the scroll itself leaves from the effect below, on the layout that carries it. */
  const jump = React.useCallback((group: ConfigGroup): void => {
    const box = page.current
    const head = box?.querySelector<HTMLElement>(`.superworker-cfgsec[data-cat="${group}"]`) ?? null
    const first = box?.querySelector<HTMLElement>('.superworker-cfgsec') ?? null
    if (box === null || head === null || first === null) return
    const to = Math.max(0, head.getBoundingClientRect().top - first.getBoundingClientRect().top)
    owed.current = to
    setTail(to === 0 ? 0 : Math.max(0, to + box.clientHeight - contentHeight(box)))
    setJumps((count) => count + 1)
  }, [])

  /* The room rides in with the render that carries it, so the scroll is written here, once the page
     has it — written in the click itself it would be clamped back to the range the page had then. */
  React.useLayoutEffect(() => {
    const box = page.current
    const to = owed.current
    if (box === null || to === null) return
    owed.current = null
    const from = box.scrollTop
    box.scrollTop = to
    if (box.scrollTop !== from) jumped.current = true
  }, [tail, jumps])

  /* Scrolling the page by hand moves the index to the category whose head is the last one above the
     page's top edge. At the very top of the page no head has crossed that edge yet — the first
     section is the answer then, not "the category before this one". */
  const track = React.useCallback((): void => {
    if (jumped.current) {
      jumped.current = false
      return
    }
    const box = page.current
    if (box === null) return
    const edge = box.getBoundingClientRect().top + 4
    let seen: ConfigGroup | null = null
    for (const head of box.querySelectorAll<HTMLElement>('.superworker-cfgsec')) {
      const group = head.getAttribute('data-cat') as ConfigGroup | null
      if (group === null) continue
      if (seen === null || head.getBoundingClientRect().top <= edge) seen = group
    }
    if (seen !== null) setAt(seen)
  }, [])

  return (
    <PaneFrame id="config" active={active} noNodes={noNodes} fill ariaLabel={t('common.settings')}>
      {reading === null || sections.length === 0 ? null : (
      <div className="superworker-cfg">
        <nav className="superworker-cfgnav" aria-label={t('config.categories.aria')}>
          <div className="superworker-cfglist">
            {sections.map((section) => (
              <button
                key={section.group}
                type="button"
                className="superworker-cfgitem"
                data-cat={section.group}
                aria-current={pointed === section.group}
                onClick={() => { jump(section.group); setAt(section.group) }}
              >
                <span className="superworker-cfgitem-name">{t(GROUP_WORDS[section.group])}</span>
                <span className="superworker-cfgitem-count">{section.rows.length}</span>
              </button>
            ))}
          </div>
          <div className="superworker-cfgnavfoot">
            <span className="superworker-cfgnavfoot-term">{t('config.file.term')}</span>
            <code className="superworker-cfgnavfoot-path">.superworker/config.json</code>
          </div>
        </nav>
        <div
          className="superworker-cfgpage"
          ref={page}
          role="region"
          aria-label={t('common.settings')}
          tabIndex={0}
          onScroll={track}
        >
          {sections.map((section) => (
            <Section
              key={section.group}
              section={section}
              entries={reading.entries}
              revision={tick}
              onWrite={send}
            />
          ))}
          {tail > 0 ? (
            <div className="superworker-cfgtail" aria-hidden="true" style={{ ['--superworker-cfgtail' as string]: `${String(tail)}px` }} />
          ) : null}
        </div>
      </div>
      )}
    </PaneFrame>
  )
}

function Section(props: {
  readonly section: ConfigSection
  readonly entries: Readonly<Record<string, ConfigEntry>>
  readonly revision: number
  readonly onWrite: (key: string, value: string) => void
}): React.ReactElement {
  const t = useT()
  const { section } = props
  return (
    <section className="superworker-cfgsec" data-cat={section.group}>
      <header className="superworker-cfgsechead">
        <h2 className="superworker-cfgsecname">{t(GROUP_WORDS[section.group])}</h2>
        <span className="superworker-cfgserule" aria-hidden="true" />
      </header>
      <div className="superworker-cfgrows">
        {section.rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            entry={props.entries[row.key]}
            revision={props.revision}
            onWrite={(next) => { props.onWrite(row.key, next) }}
          />
        ))}
      </div>
    </section>
  )
}

function Row(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const t = useT()
  const { row, entry } = props
  const noteId = `cfg-note-${row.key}`
  const words = rowWords(t, row)
  return (
    <div className="superworker-cfgrow" data-key={row.key}>
      <div className="superworker-cfgrowname">
        {/* The key itself rides along as the hint: the name is the reader's word, the record's word is what the tool takes. */}
        <span className="superworker-setlabel" title={row.name === null ? undefined : row.key}>{words.name}</span>
        <span className="superworker-setcaption" id={noteId}>{words.caption}</span>
      </div>
      {row.kind === 'pick'
        ? <Pick row={row} entry={entry} noteId={noteId} onWrite={props.onWrite} />
        : row.kind === 'num'
          ? <NumberBox row={row} entry={entry} noteId={noteId} revision={props.revision} onWrite={props.onWrite} />
          : row.kind === 'toggle'
            ? <Toggle row={row} entry={entry} noteId={noteId} onWrite={props.onWrite} />
            : <TextBox row={row} entry={entry} noteId={noteId} revision={props.revision} onWrite={props.onWrite} />}
      {entry === undefined || entry.layer === null
        ? null
        : <span className="superworker-tag superworker-vlayer" data-layer={entry.layer}>{t(LAYER_WORDS[entry.layer])}</span>}
    </div>
  )
}

function Pick(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const t = useT()
  const pick = pickState(props.entry, props.row.options ?? [])
  return (
    <span className="superworker-pick">
      <select
        aria-label={rowWords(t, props.row).name}
        aria-describedby={props.noteId}
        value={pick.value}
        onChange={(event) => props.onWrite(event.target.value)}
      >
        {/* No value: leave an empty slot for it to land on, so the browser does not pick the first option; this option is not offered for picking. */}
        {pick.value === '' ? <option value="" hidden /> : null}
        {(props.row.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        {/* A value in the reading but not in the candidate table: laid out as its own option, keeping the view consistent with the record. */}
        {pick.extra === null ? null : <option value={pick.extra}>{pick.extra}</option>}
      </select>
    </span>
  )
}

/**
 * The number control: writes only on commit (Enter or blur); keystrokes in between live only in the box.
 *
 * `revision` flips on every write, and on each flip the box swaps to the re-read copy — a refused
 * number does not squat in the box.
 *
 * The tool marks a limit nobody has filled in with its own word (a dash); a number box cannot hold
 * that, and showing an empty box without saying so would read as "the value is zero". Such a row
 * draws as unset instead — the reading says no number stands there, and the box says the same.
 */
function NumberBox(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const t = useT()
  const held = props.entry?.value ?? ''
  const numeric = held.length > 0 && Number.isFinite(Number(held))
  return (
    <CommitNumberInput
      held={held}
      unset={!numeric}
      label={rowWords(t, props.row).name}
      describedBy={props.noteId}
      revision={props.revision}
      onCommit={(typed) => {
        if (typed.length === 0 || typed === held) return
        props.onWrite(typed)
      }}
    />
  )
}

/**
 * The text control (for unregistered keys): the number control's commit rules on the shared input,
 * as a text box — writes only on commit (Enter or blur), keystrokes in between live only in the
 * box, and it yields only when a reading arrives, so a refused word does not squat in the box. Every
 * key that can reach this row exists in the reading, so the box starts out holding the reading's
 * value, and a reading never leaves a key unset here.
 */
function TextBox(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly revision: number
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const t = useT()
  const held = props.entry?.value ?? ''
  return (
    <CommitNumberInput
      type="text"
      spellCheck={false}
      held={held}
      unset={false}
      label={rowWords(t, props.row).name}
      describedBy={props.noteId}
      revision={props.revision}
      onCommit={(typed) => {
        if (typed.length === 0 || typed === held) return
        props.onWrite(typed)
      }}
    />
  )
}

/** The on / off control: two buttons, the pressed one being the current value; neither lights when the record does not carry the key. */
function Toggle(props: {
  readonly row: ConfigRow
  readonly entry: ConfigEntry | undefined
  readonly noteId: string
  readonly onWrite: (value: string) => void
}): React.ReactElement {
  const t = useT()
  const on = props.entry === undefined ? null : props.entry.value === 'on'
  return (
    <div className="superworker-seg" role="group" aria-label={rowWords(t, props.row).name}>
      {SIDES.map(([word, flag]) => (
        <button
          key={word}
          type="button"
          className="superworker-segbtn"
          aria-pressed={on === flag}
          aria-describedby={props.noteId}
          onClick={() => props.onWrite(flag ? 'on' : 'off')}
        >
          {t(word)}
        </button>
      ))}
    </div>
  )
}