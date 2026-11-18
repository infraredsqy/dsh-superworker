/**
 * The main panel's shell: the six-pane tab row, switching between views, the fetch lines for
 * readings and preferences, and the assembly of each pane.
 *
 * Each pane's own layout is its own document: the map `map.tsx` (with its layout engine in
 * `map-layout.ts`), the overview `overview.tsx` (with its layout in `overview-geom.ts` and the
 * session-event windows in `session-events.ts`; its empty stage is `overview-empty.tsx`), detail
 * `detail.tsx`, instruction book `notes.tsx`, project settings `config.tsx`, and the issue pane
 * `pool.tsx`; the modal is `delete-confirm.tsx`; the legacy-directory notice that replaces the whole
 * stage is `legacy.tsx`; the reading widgets shared by the map, detail, and instruction book are in
 * `marks.tsx`.
 *
 * Not a single reading is computed here: the four records arrive through the port, and the pure
 * functions in `src/model` read them into the reading for this moment; this layer only draws it. The
 * panel's own display preferences live in the Host's settings document, read and written through
 * the port in `prefs.ts`.
 */
import * as React from 'react'
import type { SuperworkerReading } from '../host/contract.ts'
import type { InstructionReading, OverviewReading, OverviewSnapshot } from '../model/index.ts'
import { everySourceIs, readOverview, readProject, readSessions, strandedCycleOf } from '../model/index.ts'
import type { PrefField, PrefsSource, ViewId } from './prefs.ts'
import { clampSide, DEFAULT_SOURCE, PANEL_PREF_FIELDS, VIEW_IDS, VIEW_WORDS } from './prefs.ts'
import { useT } from './locale.ts'
import { failureWord, legacyNoticeWords, overviewEmptyWords, type OverviewEmpty } from './words.ts'
import type { Outcome } from './failure.ts'
import type { Load as LoadOf, Note } from './outcome.ts'
import { writeToNote } from './outcome.ts'
import type { PanelPort } from './data.ts'
import { NO_WORKSPACES, workspaceOf, type WorkspaceSource } from './workspaces.ts'
import { NO_WINDOWS, type SessionWindows } from './session-events.ts'
import { READING_CAPACITY } from './overview-geom.ts'
import { OverviewPane } from './overview.tsx'
import { OverviewEmptyStage } from './overview-empty.tsx'
import { MapPane, type CardGo } from './map.tsx'
import { ConfigPane } from './config.tsx'
import { DeleteConfirm } from './delete-confirm.tsx'
import { DetailPane, pickedCycleOf } from './detail.tsx'
import { LegacyNotice } from './legacy.tsx'
import { NotesPane } from './notes.tsx'
import { IssuePool } from './pool.tsx'
import { PaneFrame } from './widgets.tsx'

/* The six views, in tab order: the ids are the settings document's own list (VIEW_IDS). Every pane
 * fills the stage's footprint; the word on each tab is looked up when the tab row is drawn. */
const VIEWS = VIEW_IDS

export interface PanelProps {
  readonly port: PanelPort
  /** Which workspace to read, by the session it belongs to; without it nothing can be drawn. */
  readonly sessionId?: string | undefined
  /** Which settings document holds the panel's own preferences. Factory defaults apply when absent. */
  readonly prefs?: PrefsSource | undefined
  /** Where card clicks go: DSH's navigation gateway. Cards are inert without it. */
  readonly openSession?: ((target: string) => void) | undefined
  /** Which sessions exist on this machine right now: it decides whether the session a card points to is among them. */
  readonly knownSessions?: ReadonlySet<string> | undefined
  /** DSH's workspace list, the source of the selector at the top of the panel; without it no workspace is pickable and only this session's own workspace is read. */
  readonly workspaces?: WorkspaceSource | undefined
  /** The session-list snapshot as the browser holds it this moment: the overview's windows and their liveness read straight off it. */
  readonly sessions?: unknown
  /** The session-event windows the overview's rows fold from; without it the windows draw their words alone. */
  readonly windows?: SessionWindows | undefined
}

/** The notes when there is no session yet: no pane has anywhere to go. */
const NO_NOTES: Readonly<Record<string, string>> = Object.freeze({})

/** The claims when nothing has been read: no cell is held to have a claim at all. */
const NO_CLAIMS: Readonly<Record<string, string>> = Object.freeze({})

const NO_SESSIONS: ReadonlySet<string> = new Set<string>()

/** How far one reading has got, widened with this shell's own phase. Which words a failure reads as is
 * decided where it is drawn. */
type Load =
  | LoadOf<SuperworkerReading>
  /** No session is selected, so there is no workspace to read and no failure to speak of. */
  | { readonly phase: 'no-session' }

/**
 * The level the panel reads at this moment, for a preference that also has a row on the settings
 * page (the two switches and the dragged width): the document leads — the page can flip it while
 * this screen stands — and the reader's change on this screen leads from the spot until the
 * document's next value arrives.
 * @param stored - The value the settings document states at this moment.
 */
function usePreference<T>(stored: T): [T, (next: T) => void] {
  const [local, setLocal] = React.useState<T>(stored)
  React.useEffect(() => {
    setLocal(stored)
  }, [stored])
  return [local, setLocal]
}

/**
 * The view this screen is showing: the reader's pick, and nothing else.
 *
 * Which view to show has one authority — this screen. The remembered view in the settings document
 * is a *seed*: it is read until the reader picks (the panel draws before the settings form is in
 * hand, so the seed has to be able to arrive late), and from the first pick on the document is
 * only where the pick is written. It is never read back over the screen.
 *
 * That one-way road is the whole point. A settings write is a round trip (host write → document
 * push → read-back), and the panel's second click in a burst is fenced on a revision the earlier
 * write already moved, so the earlier view's echo — and the read-back of the refused write — land
 * *after* the reader has picked again. Adopting those, as a two-way mirror does, is what flipped
 * the stage back to the view the reader had just left. Unlike the switches, the view has no row on
 * the settings page: nothing but this screen writes it, so there is no change from elsewhere that
 * this one-way road could miss.
 * @param seeded - The remembered view the settings document states at this moment.
 */
function useView(seeded: ViewId): [ViewId, (next: ViewId) => void] {
  const [held, setHeld] = React.useState<ViewId>(seeded)
  /* Whether the reader has picked since this screen came up: after that the document is a sink. */
  const picked = React.useRef(false)
  React.useEffect(() => {
    if (!picked.current) setHeld(seeded)
  }, [seeded])
  const pick = React.useCallback((next: ViewId) => {
    picked.current = true
    setHeld(next)
  }, [])
  return [held, pick]
}

export function SuperworkerPanel(props: PanelProps): React.ReactElement {
  const { port, sessionId, openSession, knownSessions } = props
  /* Every word this pane prints comes from here. The translator reads the active language at call
   * time, so a redraw after a language switch says the new one without anything being re-created. */
  const t = useT()
  /* The workspace selector at the top of the panel: the candidates are DSH's own list, and the read
   * goes to the picked workspace. The picked one lives only on this screen; the panel's own
   * preferences have nothing to do with it, and no key is left in local storage. Before anything is
   * picked it follows whichever bucket this session falls into; a session belonging to no workspace
   * is "ungrouped", which is exactly this session's own root. */
  const workspaceStore = props.workspaces ?? NO_WORKSPACES
  const workspaceList = React.useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  )
  const items = workspaceList.items
  const mine = React.useMemo(() => workspaceOf(items, sessionId), [items, sessionId])
  const [pickedSpace, setPickedSpace] = React.useState<string | null | undefined>(undefined)
  const chosen = React.useMemo(() => {
    if (pickedSpace === undefined) return mine
    if (pickedSpace === null) return undefined
    /* The picked one is no longer in the list (deleted elsewhere): fall back to this session's own bucket. */
    return items.find((item) => item.workspaceId === pickedSpace) ?? mine
  }, [pickedSpace, mine, items])
  /* The root handed to the host half: an empty string means nothing was picked, read by this session's own root. */
  const workspaceRoot = chosen?.path ?? ''
  /* The session belongs to some workspace yet the reader picked "ungrouped": ungrouped is no root,
   * so do not read. Without this step the empty root would ride the session's cwd back to the
   * workspace it belongs to — usually the very one from before, the screen unmoved, looking like a
   * stale frame. When this session itself sits in the ungrouped bucket, "ungrouped" is still its
   * own root, and the read goes on. */
  const pickedNone = pickedSpace === null && mine !== undefined
  /* The panel's own preferences: the reading comes from that settings form, and the write goes out
   * through the same port; before the settings service attaches it serves the factory defaults, and
   * the panel draws as usual. */
  const store = props.prefs ?? DEFAULT_SOURCE
  const preferences = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const stored = preferences.prefs
  /* The view is the one preference that is this screen's own: the document seeds it, the picker
   * leads it, and a write echo never moves it back (`useView`). The three below mirror settings
   * rows the settings page also flips, so the document leads those. */
  const [tab, setTab] = useView(stored.tab)
  const [sideWidth, setSideWidth] = usePreference<number>(stored.sideWidth)
  const [otherStates, setOtherStates] = usePreference<boolean>(stored.otherStates)
  /* This screen only reads the archived flag — the settings page is where it is flipped — but it
   * takes the same road as the three above: one hook is what every preference this pane reads goes
   * through, so the next field that becomes writable here does not have to be re-plumbed onto a
   * second pipe (a direct store read that quietly disagrees with the local copy). */
  const [archived] = usePreference<boolean>(stored.archived)
  const [load, setLoad] = React.useState<Load>({ phase: 'loading' })
  const [notes, setNotes] = React.useState<Readonly<Record<string, string>>>(NO_NOTES)
  /* The dispatch claims and the live-agent roster: the two machine-side facts the stranded reading
     judges. An unreadable reading holds neither fact, and an unknown roster (null) never reads as
     "gone". */
  const [claims, setClaims] = React.useState<Readonly<Record<string, string>>>(NO_CLAIMS)
  const [alive, setAlive] = React.useState<ReadonlySet<string> | null>(null)
  /* Whether the record's session side has answered on this pass. An empty set of notes is only "the
   * record names no session" once it has: before that it means "not read yet", and the overview's
   * empty stage would say the wrong one of its three sentences for a beat and take it back. */
  const [sessionsRead, setSessionsRead] = React.useState(false)
  /* The session-event windows behind the overview: one external store, read the same way every
   * pushed state here is read — its durable events and, beside them, the windows' transient live
   * chunks (the streaming step's own half, redrawn at the animation frame by the forwarding half).
   * Absent, every window simply draws no rows. */
  const windows = props.windows ?? NO_WINDOWS
  const events = React.useSyncExternalStore(windows.subscribe, windows.getSnapshot, windows.getSnapshot)
  const live = React.useSyncExternalStore(windows.subscribe, windows.getLive, windows.getLive)
  /* Which moment the read happened at: fixed on the fetch beat. Everything displays by it — the
   * reading already carries this moment; "now" is never fetched separately. */
  const [at, setAt] = React.useState<Date>(() => new Date())
  const [tick, setTick] = React.useState(0)
  const [note, setNote] = React.useState<Note | null>(null)
  const [lineId, setLineId] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<InstructionReading | null>(null)
  /* The cell whose open-session write is in flight: that cell's own action stands disabled until
   * the write settles, success or refusal alike — settling a round takes the model minutes, and a
   * second click inside that window would open a second session on the same cell. The
   * per-workspace queue serializes opens; this gate is the cell's own completeness. */
  const [openingNode, setOpeningNode] = React.useState<string | null>(null)
  /* Whether the legacy notice's migration hand is in flight: the notice's action stands disabled
   * until the call settles, success or refusal alike — a second click inside that window would
   * open a second migration session for the same workspace. */
  const [consulting, setConsulting] = React.useState(false)

  /* The one channel: every reading this panel draws arrives as a frame — the four records and the
   * record's session side, read together at one moment by the host and pushed whenever they change
   * (a word writing files, a session starting or ending, this panel's own write). So there is no
   * fetch beat to keep in step with anything: the panes render one fact, and the frame's own moment
   * (`at`) is what every display is measured from. A frame whose halves could not be read leaves the
   * last good reading in place and states the refusal, rather than drawing an invented empty one.
   *
   * The effect re-subscribes when the workspace changes and after a write of ours lands (`tick`):
   * on a host with a stream the pump has already sent the new frame, and this only re-arms; on a
   * deployment without one, the re-arm is what re-reads. */
  React.useEffect(() => {
    if (sessionId === undefined || sessionId.length === 0) {
      setLoad({ phase: 'no-session' })
      return undefined
    }
    if (pickedNone) return undefined
    let live = true
    setLoad((held) => (held.phase === 'ok' ? held : { phase: 'loading' }))
    const off = port.watch(sessionId, workspaceRoot, (frame) => {
      if (!live) return
      setAt(new Date(frame.at))
      if (frame.reading !== null) {
        setLoad({ phase: 'ok', reading: frame.reading })
      } else if (frame.failure !== undefined) {
        setLoad({ phase: 'failed', failure: { code: 'transport-failed', ...(frame.failure.detail !== undefined ? { detail: frame.failure.detail } : {}) } })
      }
      /* The session side arrives on the same frame: notes, the dispatch claims, and the live roster
       * the stranded reading judges. A refused half is no reading at all — the overview keeps its
       * silence rather than claiming the record names nothing when the truth is that nobody looked. */
      if (frame.sessions === null) {
        setNotes(NO_NOTES)
        setClaims(NO_CLAIMS)
        setAlive(null)
        setSessionsRead(false)
        return
      }
      setNotes(readSessions(frame.sessions.notes))
      setClaims(frame.sessions.claims)
      setAlive(frame.sessions.alive === null ? null : new Set(frame.sessions.alive))
      setSessionsRead(true)
    })
    return () => {
      live = false
      off()
    }
  }, [port, sessionId, workspaceRoot, tick, pickedNone])

  /* The click on a card: only when the record's session is on this machine right now does the card
   * click through. The session identity is recognized in two places — this machine's own notes
   * first, then the field on the record itself. Missing either the roster or the navigation gateway,
   * every card on this screen sits quietly. */
  const cardGo = React.useMemo<CardGo | null>(() => {
    if (openSession === undefined) return null
    const known = knownSessions ?? NO_SESSIONS
    return {
      targetOf: (node) => {
        const session = notes[node.id] ?? node.session
        return session !== undefined && session.length > 0 && known.has(session) ? session : null
      },
      open: openSession,
    }
  }, [notes, knownSessions, openSession])

  const reading = load.phase === 'ok' ? load.reading : null
  const project = React.useMemo(
    () => (reading === null
      ? null
      : readProject({
        nodes: reading.nodes,
        cycles: reading.cycles,
        instructions: reading.instructions,
        issues: reading.issues,
        at,
      })),
    [reading, at],
  )

  const cycles = project?.cycles ?? []
  /* Which line the detail pane is showing, and therefore which line a card's "open" acts on: this
   * shell keeps only the id — the one thing the port needs — and both ends ask the same one
   * resolution (`pickedCycleOf`), so the line the body lists and the line reported to the port
   * cannot be different ones. */
  const pickedLine = pickedCycleOf(cycles, lineId)

  /* The stranded dispatches, judged once per reading: claim on disk, the cell still held, and the
     session its note names absent from this host's live agents. The judgment is the model's; the
     three facts only meet here. */
  const stranded = React.useMemo(() => {
    const out: Record<string, string> = {}
    for (const node of project?.nodes ?? []) {
      const cycleId = strandedCycleOf(node, claims, notes, alive)
      if (cycleId !== null) out[node.id] = cycleId
    }
    return out
  }, [project, claims, notes, alive])

  /* Whether this workspace has any nodes: not a single cell in the reading means none. When there
   * are none, the five node-following panes each collapse to one sentence, and the header's count
   * row goes away with them — empty column heads and three zeros would be speaking for a record
   * that says nothing. The invariant "the four sources are disjoint and together the whole" holds in
   * one place, the model layer; it is not re-derived here by summing column lengths. */
  const noNodes = project !== null && project.nodes.length === 0

  /* Which node each session works, the notes' own reading turned the overview's way round: the
   * notes name a session per node, a window's nameplate reads the node by its session. */
  const nodeOf = React.useMemo(() => {
    const out: Record<string, string> = {}
    for (const [node, session] of Object.entries(notes)) out[session] = node
    return out
  }, [notes])

  /* The sessions whose node owes a person a word: the record's own gate reading, both kinds — a
   * checkpoint (delivered, and that delivery not approved) or a manual node nobody is working. A gate
   * is a person being owed, so a manual node whose leg is running right now is not one: it is being
   * worked. The overview draws such a window as waiting instead of finished or broken; the judgment
   * stays the model's, only the fact is handed over. */
  const waitingSessions = React.useMemo((): readonly string[] => {
    const out: string[] = []
    for (const [session, nodeId] of Object.entries(nodeOf)) {
      const node = project?.nodeById[nodeId]
      if (node === undefined) continue
      if (node.gate?.kind === 'checkpoint') out.push(session)
      else if (node.gate?.kind === 'manual' && !node.running) out.push(session)
    }
    return out
  }, [nodeOf, project])

  /* The sessions whose node the record calls delivered: the node's state is `completed`. The gate
   * still wins over this in the overview's own reading (a delivered checkpoint owes a person a word,
   * not a check), so nothing has to be subtracted here. When every node is delivered the whole
   * pipeline has handed itself in, and the conversation this panel lives in carries that verdict even
   * when it works no node of its own. */
  const deliveredSessions = React.useMemo((): readonly string[] => {
    const out: string[] = []
    for (const [session, nodeId] of Object.entries(nodeOf)) {
      if (project?.nodeById[nodeId]?.state === 'completed') out.push(session)
    }
    const nodes = project?.nodes ?? []
    if (sessionId !== undefined && sessionId.length > 0 && nodes.length > 0
      && nodes.every((node) => node.state === 'completed') && !out.includes(sessionId)) {
      out.push(sessionId)
    }
    return out
  }, [nodeOf, project, sessionId])

  /* The nodes the dispatch reading calls stranded — claim on disk, cell still held, its session gone
   * from this host's live roster: the one debt the overview can name as owed by nobody. */
  const strandedNodes = React.useMemo((): readonly string[] => Object.keys(stranded), [stranded])

  /* The overview's reading at this beat: which windows from the session list the browser already
   * holds, which rows from the event windows `windows` holds open — settled rows from the durable
   * log, and the streaming step's live tails from its transient chunks — and which nameplate
   * material from the record. Which conversation is the main window is decided by the pipeline's
   * own record: the sessions its node notes name are the only ones this pane may draw, and this
   * panel's own session wins among them. DSH's `retainedBy.mainView` is deliberately not trusted
   * here — it marks whichever conversation the browser holds open, and an unrelated old one
   * carrying it is exactly how a foreign conversation got drawn. The rows ride a capacity — what
   * the tallest feed could ever stand; whatever a smaller box cannot show is the pane's fade, not
   * a scrollbar. */
  const overview = React.useMemo((): OverviewReading | null => {
    if (reading === null) return null
    return readOverview({
      sessions: (props.sessions ?? {}) as OverviewSnapshot,
      sessionId,
      pipelineSessions: Object.values(notes),
      events,
      live,
      nodeOf,
      nodes: reading.nodes,
      capacity: READING_CAPACITY,
      waitingSessions,
      deliveredSessions,
      strandedNodes,
    })
  }, [reading, events, live, nodeOf, props.sessions, sessionId, notes, waitingSessions, deliveredSessions, strandedNodes])

  /* The overview's empty stage: the record is in hand and yet no window stands. Which of the three
   * it is is what the stage says — a workspace with no node at all, one whose record names no
   * session that ever ran here, or one whose named sessions this machine cannot draw now — and they
   * are kept apart because they are different things to know. The distinction is judged from the
   * record side (the reading names the nodes, the notes name the sessions); whether any window
   * stands at all is the overview's own `main`. */
  const emptyKind: OverviewEmpty | null = overview === null || overview.main !== null || !sessionsRead
    ? null
    : noNodes
      ? 'no-nodes'
      : Object.keys(notes).length === 0
        ? 'no-session'
        : 'no-window'
  const emptyWords = emptyKind === null ? null : overviewEmptyWords(t, emptyKind)

  /* The event windows the overview holds open are exactly the windows the reading names — the main
   * conversation and the children still running — and only while the overview is the shown pane.
   * Re-watching the same ids is nothing; the ids that left are released there. */
  React.useEffect(() => {
    if (tab !== 'overview' || overview === null) {
      windows.watch([])
      return
    }
    windows.watch(
      [overview.main?.id, ...overview.children.map((one) => one.id)].filter((one) => one !== undefined),
    )
  }, [windows, overview, tab])
  React.useEffect(() => () => windows.watch([]), [windows])

  /* Every write on the panel goes through this hand: put the sentence verbatim onto the note line,
   * and on success read again (`tick` moves, and the reading effect above re-runs). Returning
   * "did it land" is for the "record one" row — only a landed sentence clears the box; when the
   * tool refuses, the original words stay in the box for further editing. */
  const onWrite = React.useCallback(
    (run: () => Promise<Outcome>): Promise<boolean> => {
      setNote(null)
      /* The loop itself is one hand (`writeToNote`): what came back reads the same on this note line
       * as it does on the settings page's, and returning "did it land" is for the "record one" row —
       * only a landed sentence clears the box. */
      return writeToNote(run, {
        note: (next) => setNote(next),
        after: (landed) => { if (landed) setTick((value) => value + 1) },
      })
    },
    [],
  )

  /* The consult hand behind both nothing-to-draw notices — the legacy notice's migration action and
   * the overview's empty stage. The whole move is the host opening an agent session, so this loop
   * deliberately carries no read-again: a landed call changes nothing on this panel (the work
   * happens in the session it opens, and a re-read could only repeat the same notice), and only a
   * refusal has a word for the note line. One hand for both, because the two differ in which door
   * they open and never in what the panel does with the answer. */
  const consult = React.useCallback((open: () => Promise<Outcome>) => {
    if (consulting) return
    setConsulting(true)
    setNote(null)
    void writeToNote(open, { note: (next) => setNote(next) }).finally(() => setConsulting(false))
  }, [consulting])

  const consultMigration = React.useCallback(() => {
    consult(() => port.consultMigration(sessionId ?? '', workspaceRoot))
  }, [consult, port, sessionId, workspaceRoot])

  const consultSetup = React.useCallback(() => {
    consult(() => port.consultSetup(sessionId ?? '', workspaceRoot))
  }, [consult, port, sessionId, workspaceRoot])

  /* The change made on the panel: the changed value leads, then it is written back to the settings
   * document — both sides read the same form, so the settings page's row moves on the spot too.
   * When the write cannot land, the control does not silently snap back: the sentence in the port's
   * reading lands on the note line below, and when the service has not arrived there is its own
   * sentence for that too. */
  const prefNote = React.useRef<Note | null>(null)
  const keep = React.useCallback((field: PrefField, value: unknown): void => {
    void store.write(field, value).then((accepted) => {
      /* Two different failures are possible and they read differently: the settings service refused
       * the change, or there is no settings service at all and the change lives only on this screen. */
      const said: Note | null = accepted
        ? null
        : { kind: 'failure', failure: { code: store.getSnapshot().refused ? 'settings-refused' : 'settings-unwritable' } }
      const was = prefNote.current
      prefNote.current = said
      /* On success take the previous "not saved" sentence back; other notes (the write-side ones) stay put. */
      if (said === null) setNote((held) => (held === was ? null : held))
      else setNote(said)
    }, () => undefined)
  }, [store])

  const pickView = React.useCallback((id: ViewId) => {
    setTab(id)
    keep(PANEL_PREF_FIELDS.lastTab, id)
  }, [keep])

  const pickOtherStates = React.useCallback((on: boolean) => {
    setOtherStates(on)
    keep(PANEL_PREF_FIELDS.showOtherStates, on)
  }, [keep])

  /* Whether this screen has anything to say. Picking "ungrouped" while this session has a home
   * means that pane has no record under it; none of the four sources listed means this workspace
   * has no such record; listed but none parseable means unreadable. In all three cases all five
   * panes are speechless, and the pane collapses to one sentence — the plaque and the workspace
   * selector stay; tabs and body go together. */
  const nothing = pickedNone
    ? t('panel.ungrouped-empty')
    : load.phase === 'no-session'
      ? t('panel.no-session')
      : load.phase === 'failed'
        ? failureWord(t, load.failure)
        : reading !== null && everySourceIs(reading, 'missing')
          ? t('panel.no-record')
          : reading !== null && everySourceIs(reading, 'unusable')
            ? t('panel.unreadable')
            : null

  /* The legacy-directory state is a fourth nothing-to-draw case, but it says more than one
   * sentence: the workspace still holds only the previous record directory, so the content area
   * gives way to the notice — tabs and body go together here exactly as they do above. The words
   * come from `words.ts`, judged from the reading; `null` means this reading is not one of those. */
  const legacy = reading !== null ? legacyNoticeWords(t, reading) : null

  return (
    <div className="superworker-page">
      <header className="superworker-head">
        <div className="superworker-head-left">
          <div className="superworker-head-top">
            <span className="superworker-brand">{t('brand.mark')}</span>
            {items.length === 0 ? null : (
              <span className="superworker-pick">
                <select
                  aria-label={t('workspace.aria')}
                  value={chosen?.workspaceId ?? ''}
                  onChange={(event) => setPickedSpace(event.target.value.length === 0 ? null : event.target.value)}
                >
                  {items.map((item) => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
                  {/* The pile of sessions belonging to no workspace, which DSH itself calls "ungrouped", stands last on the list. */}
                  <option value="">{t('workspace.ungrouped')}</option>
                </select>
              </span>
            )}
          </div>
        </div>
        {nothing === null && legacy === null ? (
          <div className="superworker-tabs" role="tablist">
            {VIEWS.map((id) => (
              <button
                key={id}
                type="button"
                className="superworker-tab"
                id={`tab-${id}`}
                role="tab"
                aria-selected={id === tab}
                aria-controls={`pane-${id}`}
                onClick={() => pickView(id)}
              >
                {t(VIEW_WORDS[id])}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {legacy !== null ? (
        <LegacyNotice notice={legacy} busy={consulting} onConsult={consultMigration} />
      ) : nothing === null ? (
      <div className="superworker-stage">
        {/* The frame fills the footprint in every view — each pane scrolls what does not fit inside
            itself — and every pane inside it is a direct child, so its own `flex` does the sharing. */}
        <div className="superworker-frame is-fill" id="frame">
          {/* The overview's pane draws the session's windows over one stage: the reading above
              carries the windows and their rows, this cell only stands the pane under its tab. No
              window to draw is an empty stage with its own sentence and its own move, never a
              stand-in window: the law is "draw nothing that is not there". */}
          <PaneFrame id="overview" active={tab === 'overview'} noNodes={false} fill>
            {overview === null
              ? null
              : emptyWords === null
                ? <OverviewPane reading={overview} at={at} />
                : <OverviewEmptyStage words={emptyWords} busy={consulting} onConsult={consultSetup} />}
          </PaneFrame>

          <MapPane
            active={tab === 'map'}
            noNodes={noNodes}
            project={project}
            go={cardGo}
            stranded={stranded}
            onRefresh={() => setTick((value) => value + 1)}
          />

          <DetailPane
            active={tab === 'detail'}
            noNodes={noNodes}
            lineId={lineId}
            project={project}
            stranded={stranded}
            sideWidth={sideWidth}
            onSideWidth={setSideWidth}
            onSideCommit={(px) => keep(PANEL_PREF_FIELDS.sideWidth, clampSide(px))}
            onPickLine={setLineId}
            openingNode={openingNode}
            onOpenNode={(nodeId) => {
              if (pickedLine === null || openingNode === nodeId) return
              setOpeningNode(nodeId)
              void onWrite(() => port.openNodeSession(sessionId ?? '', workspaceRoot, pickedLine.id, nodeId)).finally(() => setOpeningNode(null))
            }}
          />

          <NotesPane
            active={tab === 'notes'}
            noNodes={noNodes}
            project={project}
            showArchived={archived}
            onAdd={(text, scope, cycle, node) => (
              onWrite(() => port.say(sessionId ?? '', workspaceRoot, text, scope, cycle, node))
            )}
            onArchive={(id) => { void onWrite(() => port.write('archive', sessionId ?? '', workspaceRoot, id)) }}
            onRevive={(id) => { void onWrite(() => port.write('revive', sessionId ?? '', workspaceRoot, id)) }}
            onDelete={(instruction) => setDeleting(instruction)}
          />

          {/* This pane acts as its own page root: the `is-embed` yield marker hangs on it together
              with the page marker (`superworker-issue`), and the build gateway folds that sheet by its own
              page marker. */}
          <PaneFrame id="issue" active={tab === 'issue'} noNodes={false} className="is-frame is-embed superworker-issue" fill>
            {project === null ? null : (
              <IssuePool project={project} showOtherStates={otherStates} onShowOtherStates={pickOtherStates} />
            )}
          </PaneFrame>

          <ConfigPane
            port={port}
            sessionId={sessionId ?? ''}
            workspaceRoot={workspaceRoot}
            noNodes={noNodes}
            active={tab === 'config'}
            onNote={setNote}
          />
        </div>
      </div>
      ) : (
        <div className="superworker-none">
          <p>{nothing}</p>
        </div>
      )}

      {note === null ? null : (
        <p className="superworker-innone">{note.kind === 'said' ? note.text : failureWord(t, note.failure)}</p>
      )}

      {deleting === null ? null : (
        <DeleteConfirm
          instruction={deleting}
          said={deleting.text ?? ''}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting.id
            setDeleting(null)
            onWrite(() => port.write('remove', sessionId ?? '', workspaceRoot, id))
          }}
        />
      )}
    </div>
  )
}
