/**
 * The main panel's shell: the six-pane tab row, switching between views, the fetch lines for
 * readings and preferences, and the assembly of each pane.
 *
 * Each pane's own layout is its own document: the map `map.tsx` (with its layout engine in
 * `map-layout.ts`), the overview `overview.tsx` (with its layout in `overview-geom.ts`, the
 * session-event windows in `session-events.ts`, its empty stage in `overview-empty.tsx`, and its
 * standing launch corner in `overview-launch.tsx`), detail
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
import { everySourceIs, owedSessions, readBirthplaces, readJudgement, readOverview, readProject, readSessions, strandedCycleOf } from '../model/index.ts'
import type { PrefField, PrefsSource, ViewId } from './prefs.ts'
import { clampSide, DEFAULT_SOURCE, PANEL_PREF_FIELDS, VIEW_IDS, VIEW_WORDS } from './prefs.ts'
import { useT } from './locale.ts'
import { failureWord, legacyNoticeWords, overviewEmptySaid, type OverviewEmpty } from './words.ts'
import type { Outcome } from './failure.ts'
import type { Load as LoadOf, Note } from './outcome.ts'
import { writeToNote } from './outcome.ts'
import type { PanelPort } from './data.ts'
import { NO_WORKSPACES, workspaceOf, type WorkspaceSource } from './workspaces.ts'
import { NO_WINDOWS, type SessionWindows } from './session-events.ts'
import { READING_CAPACITY } from './overview-geom.ts'
import { OverviewPane, type WindowGo } from './overview.tsx'
import { OverviewEmptyStage } from './overview-empty.tsx'
import { OverviewLaunch } from './overview-launch.tsx'
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
  /**
   * The conversation the seat says this panel stands in, when it says one: the overview's main
   * window reads it ahead of the line. Absent on this panel's own full page, which has no
   * conversation of its own — and the browser's open conversation is not read in its place.
   */
  readonly ownSession?: string | undefined
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

/**
 * The tickets when none was read: no cell is held to have handed its work in.
 *
 * That is the cautious direction on purpose. A missing ticket layer paints a stopped cell as a break,
 * which is a claim the panel can be wrong about; inventing deliveries it never read would be wrong in
 * the direction that hides work nobody did — and a host that cannot open the layer at all refuses the
 * whole reading rather than answering this empty (see `readTickets`).
 */
const NO_TICKETS: Readonly<Record<string, string>> = Object.freeze({})

const NO_SESSIONS: ReadonlySet<string> = new Set<string>()

/**
 * How far one reading has got, widened with this shell's own phase. Which words a failure reads as is
 * decided where it is drawn.
 *
 * `space` rides only the arm that has a reading, and it is the record that reading was read for —
 * the frame's own root, canonical. It is kept *inside* that state rather than beside it because the
 * two are one fact: a reading and the record it is a reading of may never be drawn one commit apart,
 * or the stage would be keyed to one record while drawing another.
 */
type Load =
  | (LoadOf<SuperworkerReading> & { readonly space?: string })
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
  /* Where each node was born: the conversation that created it. A different question from `notes`,
     which names the session that works the node — a card's press goes to the birthplace, a window is
     drawn only for a working session. Kept in one state so the two can never stand in for each other. */
  const [birthplaces, setBirthplaces] = React.useState<Readonly<Record<string, string>>>(NO_NOTES)
  /* The dispatch claims and the live-agent roster: the two machine-side facts the stranded reading
     judges. An unreadable reading holds neither fact, and an unknown roster (null) never reads as
     "gone". */
  const [claims, setClaims] = React.useState<Readonly<Record<string, string>>>(NO_CLAIMS)
  /* The handoff tickets on disk, keyed by node: a cell present here handed a verdict in. Together with
     the node's own state it is how a stopped conversation is told from one that stopped before
     delivering — the conversation's log cannot make that distinction (its last turn reads `completed`
     either way), which is exactly the case this reading exists for. */
  const [tickets, setTickets] = React.useState<Readonly<Record<string, string>>>(NO_TICKETS)
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
        setLoad({ phase: 'ok', reading: frame.reading, space: frame.workspaceRoot })
      } else if (frame.failure !== undefined) {
        setLoad({ phase: 'failed', failure: { code: 'transport-failed', ...(frame.failure.detail !== undefined ? { detail: frame.failure.detail } : {}) } })
      }
      /* The session side arrives on the same frame: notes, the dispatch claims, and the live roster
       * the stranded reading judges. A refused half is no reading at all — the overview keeps its
       * silence rather than claiming the record names nothing when the truth is that nobody looked. */
      if (frame.sessions === null) {
        setNotes(NO_NOTES)
        setBirthplaces(NO_NOTES)
        setClaims(NO_CLAIMS)
        setTickets(NO_TICKETS)
        setAlive(null)
        setSessionsRead(false)
        return
      }
      setNotes(readSessions(frame.sessions.notes))
      setBirthplaces(readBirthplaces(frame.sessions.notes))
      setClaims(frame.sessions.claims)
      setTickets(frame.sessions.tickets ?? NO_TICKETS)
      setAlive(frame.sessions.alive === null ? null : new Set(frame.sessions.alive))
      setSessionsRead(true)
    })
    return () => {
      live = false
      off()
    }
  }, [port, sessionId, workspaceRoot, tick, pickedNone])

  /* The click on a card: only when the record's session is on this machine right now does the card
   * click through. A card is a node, not a session — a node that was never dispatched has no working
   * session to open, so a press lands on the conversation the node was **born in**, which is the one
   * place a reader can still see where it came from. Missing either the roster or the navigation
   * gateway, every card on this screen sits quietly. */
  const cardGo = React.useMemo<CardGo | null>(() => {
    if (openSession === undefined) return null
    const known = knownSessions ?? NO_SESSIONS
    return {
      targetOf: (node) => {
        const session = birthplaces[node.id] ?? notes[node.id] ?? node.session
        return session !== undefined && session.length > 0 && known.has(session) ? session : null
      },
      open: openSession,
    }
  }, [birthplaces, notes, knownSessions, openSession])

  /* The press on a window: the same two questions the map's cards are admitted by, asked of a session
   * instead of a node — DSH's navigation gateway has to be here, and the conversation has to be one
   * this machine's session list still holds. A window is drawn out of that list (the main one from the
   * sessions the record names, a child from the main conversation's own children), so the roster is
   * what keeps a press off a conversation the list has already let go: a child's last breath on the
   * page, while its leave animation runs and its session is no longer there to open. */
  const windowGo = React.useMemo<WindowGo | null>(() => {
    if (openSession === undefined) return null
    const known = knownSessions ?? NO_SESSIONS
    return {
      targetOf: (session) => (session.length > 0 && known.has(session) ? session : null),
      open: openSession,
    }
  }, [knownSessions, openSession])

  const reading = load.phase === 'ok' ? load.reading : null
  /* The record this drawing's reading was read for, and the identity of the overview's page. The
   * stage keys itself by it, so another record under the pane is a stage drawn from scratch: its
   * windows were never this page's windows, and nothing of the page before it may be folded, flown
   * or settled on its way out (`overview.tsx`). A frame's root is the host's own canonical answer,
   * so two spellings of one path are one page. */
  const pageSpace = load.phase === 'ok' ? (load.space ?? '') : ''
  const project = React.useMemo(
    () => (reading === null
      ? null
      : readProject({
        nodes: reading.nodes,
        cycles: reading.cycles,
        instructions: reading.instructions,
        issues: reading.issues,
        /* The table travels with the reading, read on the host off the issue plugin's own declaration:
         * the browser half cannot open a file, and a second copy of the numbers here would be the
         * drift this whole arrangement exists to prevent. */
        poolWeights: reading.poolWeights ?? null,
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

  /* The record's judgement of its own cells, assembled once: which session works which cell, and what
   * the record says about each — a person's gate, a delivery, a hold, a ticket, a claim nobody is left
   * to settle. It is the model's reading (`readJudgement`), not a judgment of this screen's: the seven
   * name lists the overview used to take are one keyed packet now, so a new verdict is added where the
   * record is read and every reader of it — the windows, the rail's bars, this screen's watch list —
   * follows without being re-plumbed. Nothing here decides what any of those words mean. */
  const judgement = React.useMemo(() => {
    if (reading === null) return undefined
    return readJudgement({
      sessions: notes,
      nodes: project?.nodeById ?? {},
      stranded,
      handed: tickets,
      panelSession: sessionId,
    })
  }, [reading, notes, project, stranded, tickets, sessionId])

  /* Which step of the line the overview's stage is drawing: the leg the reader picked on the rail,
   * and nothing else. It is this screen's own state for the same reason the tab is — a person asked
   * for it — and it is a *pick*, not a second reading: the model hands the session back into its
   * main-window rule and falls back by itself when the leg it names has left the list. Cleared when
   * the reader switches workspace: the legs of another record are not this one's to remember. */
  const [pickedLeg, setPickedLeg] = React.useState<string | null>(null)
  React.useEffect(() => {
    setPickedLeg(null)
  }, [workspaceRoot])

  /* The overview's reading at this beat: which windows from the session list the browser already
   * holds, which rows from the event windows `windows` holds open — settled rows from the durable
   * log, and the streaming step's live tails from its transient chunks — and which nameplate
   * material from the record. Which conversation is the main window is decided by the pipeline's
   * own record: the sessions its node notes name are the only ones this pane may draw, this
   * screen's own pick leads them, then the conversation the seat says the panel stands in, then
   * where the line stands. DSH's `retainedBy.mainView` is deliberately not trusted here — it marks
   * whichever conversation the browser holds open, and an unrelated old one carrying it is exactly
   * how a foreign conversation got drawn. The rows ride a capacity — what the tallest feed could
   * ever stand; whatever a smaller box cannot show is the pane's fade, not a scrollbar. */
  const overview = React.useMemo((): OverviewReading | null => {
    if (reading === null) return null
    return readOverview({
      sessions: (props.sessions ?? {}) as OverviewSnapshot,
      ownSession: props.ownSession,
      shownSession: pickedLeg ?? undefined,
      pipelineSessions: Object.values(notes),
      events,
      live,
      judgement,
      nodes: reading.nodes,
      capacity: READING_CAPACITY,
      /* The moment the frame was read at: the end a running window's span is measured to. A window
       * that stopped is measured to its own last word instead, so nothing here keeps counting. */
      at: at.getTime(),
    })
  }, [reading, events, live, judgement, props.sessions, props.ownSession, pickedLeg, notes, at])

  /* A pick names a step still on the table. Once that step has left the rail — delivered, or taken
   * over by a later step — the pick is spent, and the stage keeps the reading's own choice rather
   * than snapping back to a step that is no longer there. The reading already ignores a pick it
   * cannot seat; this only keeps the screen's own word from waiting for a return that will not come. */
  React.useEffect(() => {
    if (pickedLeg === null || overview === null) return
    if (overview.legs.some((one) => one.id === pickedLeg)) return
    setPickedLeg(null)
  }, [pickedLeg, overview])

  /* The overview's empty stage: the record is in hand and yet no window stands. Which of the three
   * it is is what the stage says — a workspace with no node at all, one whose record names no
   * session that ever ran here, or one whose named sessions this machine cannot draw now — and they
   * are kept apart because they are different things to know. The distinction is judged from the
   * record side (the reading names the nodes, the notes name the sessions); whether any window
   * stands at all is the overview's own `main`. The stage says and does nothing more: the move that
   * changes any of the three is the corner's standing doors, on the pane in every state. */
  const emptyKind: OverviewEmpty | null = overview === null || overview.main !== null || !sessionsRead
    ? null
    : noNodes
      ? 'no-nodes'
      : Object.keys(notes).length === 0
        ? 'no-session'
        : 'no-window'
  const emptySaid = emptyKind === null ? null : overviewEmptySaid(t, emptyKind)

  /* The event windows the overview holds open: every window the reading names, every leg its rail
   * offers — a bar is measured by the rows the leg's window would hold, so that log has to be open
   * before the bar can be drawn to scale — plus the sessions that could still become one — the leg's
   * dispatched workers, whose own last turn decides whether their seat stays, and every leg whose cell
   * the record still owes (`owedSessions`, the model's own list off the judgement packet, so the ids
   * the stage draws its ghosts from and the ids this screen keeps open can never disagree). A window's
   * admission is read off its own log (`turn/end`, and when it began), so that log has to be open
   * before the window exists. Only while the overview is the shown pane; re-watching the same ids is
   * nothing, and the ids that left are released there. */
  const watchIds = React.useMemo((): readonly string[] => {
    const out = new Set<string>()
    const main = overview?.main?.id
    if (main !== undefined) out.add(main)
    for (const one of overview?.children ?? []) out.add(one.id)
    for (const leg of overview?.legs ?? []) out.add(leg.id)
    /* The main's dispatched workers, untruncated: the reading's `children` are only the five
     * windows the cap kept, but a seat's admission is decided off the child's own log — the
     * ghost's `turn/end`, and when it began — so every session parented to the main, the dead
     * ones included, keeps its log open while it could still become one. The ids come from the
     * model's own reading of the snapshot (`mainChildIds`, the same set the reading draws its
     * seats from); the snapshot's shape is never re-spelled here. */
    for (const id of overview?.mainChildIds ?? []) out.add(id)
    for (const id of owedSessions(judgement)) out.add(id)
    return [...out]
  }, [overview, judgement])
  React.useEffect(() => {
    if (tab !== 'overview' || overview === null) {
      windows.watch([])
      return
    }
    windows.watch(watchIds)
  }, [windows, watchIds, overview, tab])
  React.useEffect(() => () => windows.watch([]), [windows])

  /* The stopwatch beat: a frame only goes out when the reading's content changes, so the
     moment a running span is measured to would freeze between frames — the span is the one
     fact that moves while nothing else does, and a timer read off a frozen moment says the
     same second forever, then jumps the whole silence at the next frame. While the stage
     holds a window still running, the display's moment follows this machine's clock at
     one-second steps; every pushed frame sets it back to the host's own read moment. */
  const runningShown = overview !== null
    && ((overview.main !== null && overview.main.settled !== true)
      || overview.children.some((one) => one.settled !== true))
  React.useEffect(() => {
    if (!runningShown) return undefined
    const timer = setInterval(() => setAt(new Date()), 1000)
    return () => clearInterval(timer)
  }, [runningShown])

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
   * refusal has a word for the note line. What a landed call does do is carry the panel into the
   * session it just opened. One hand for all of them, because they differ in which door they open
   * and never in what the panel does with the answer. */
  const consult = React.useCallback((open: () => Promise<Outcome>) => {
    if (consulting) return
    setConsulting(true)
    setNote(null)
    /* Pressing a door is asking to be in that conversation: the session it opens is where the work
     * now is, so the panel goes there, the same as a card or a window press does. The outcome
     * carries the id for exactly this, and the call is made once — the note line's reading of it
     * and the navigation both hang off the one answer.
     *
     * The roster check the cards and windows make is deliberately not made here: those press on a
     * conversation the browser's session list already holds, while this one was minted by the host
     * a moment ago and may not be in that list yet. Asking would refuse the very navigation that
     * was just asked for. */
    const opened = open()
    void opened.then(
      (outcome) => { if (outcome.ok && outcome.session !== undefined) openSession?.(outcome.session) },
      () => undefined,
    )
    void writeToNote(() => opened, { note: (next) => setNote(next) }).finally(() => setConsulting(false))
  }, [consulting, openSession])

  const consultMigration = React.useCallback(() => {
    consult(() => port.consultMigration(sessionId ?? '', workspaceRoot))
  }, [consult, port, sessionId, workspaceRoot])

  /* The standing corner's two doors, each a bare skill invocation for a first word: the graph's and
   * the line's own sessions. What the session then asks — whether the graph needs drawing, which
   * line to drive — is the skill's own opening conversation, so neither door carries a reading of
   * the record; the one judgment behind them is `runnable`, below, and it only greys a door. */
  const consultRoute = React.useCallback(() => {
    consult(() => port.consultRoute(sessionId ?? '', workspaceRoot))
  }, [consult, port, sessionId, workspaceRoot])

  const consultConduct = React.useCallback(() => {
    consult(() => port.consultConduct(sessionId ?? '', workspaceRoot))
  }, [consult, port, sessionId, workspaceRoot])

  /* Whether the record still holds a node that could ever be worked: any cell not yet delivered and
   * not shelved out of the game. It is the line door's light, and nothing more — which line to
   * drive, or whether a second may run while one runs, is the session's own question to ask. */
  const runnable = project !== null && project.nodes.some((node) => node.state === 'todo')

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
              window to draw is an empty stage with its own sentence, never a stand-in window: the
              law is "draw nothing that is not there". The standing corner hangs on the pane's own
              edge in every state — doors first, then the stage's sentence. */}
          <PaneFrame id="overview" active={tab === 'overview'} noNodes={false} fill className="superworker-ohost">
            {overview === null
              ? null
              : emptySaid === null
                ? <OverviewPane key={pageSpace} reading={overview} at={at} go={windowGo} pick={setPickedLeg} />
                : <OverviewEmptyStage said={emptySaid} />}
            <OverviewLaunch runnable={runnable} busy={consulting} onRoute={consultRoute} onConduct={consultConduct} />
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
