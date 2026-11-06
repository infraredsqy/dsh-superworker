/**
 * The map: one page that answers "who owes whom" and "which card to look at now", on one drawing.
 *
 * The reading comes in from the shell; this file holds only what a reader does with it — which line
 * to search under (the rail), which card is in focus, and where the camera stands. The placement and
 * the camera arithmetic live in `map-layout.ts`, so what stands here is the interaction: a wheel —
 * or two fingers pinched — zooms, a drag pans, a press on a card moves the focus, and a press on the
 * card already in focus goes to that card's session.
 *
 * Nothing here computes a reading: a rank, a lit set and a gate word are all read from the model and
 * from `map-layout.ts`.
 */
import * as React from 'react'
import type { CycleReading, NodeReading, ProjectReading } from '../model/index.ts'
import { belongsTo, bucketOf, ownersOf } from '../model/index.ts'
import { useT } from './locale.ts'
import type { Translate } from './locale.ts'
import {
  CAP,
  CARD_W,
  CARD_H,
  emphasisOf,
  fitView,
  focusView,
  lodOf,
  panView,
  place,
  rankedOf,
  rubberView,
  wirePath,
  zoomAt,
  type Size,
  type View,
} from './map-layout.ts'
import { LineMark, runningTitle, StrandedMark } from './marks.tsx'
import { nodeHover, nodeName } from './nodes.ts'
import { gateWord, stateWord, timeOf } from './words.ts'
import { PaneFrame } from './widgets.tsx'

/** The ruler used when the viewport cannot be measured: a hidden pane measures 0, and a reading never comes out as 0. */
const FALLBACK: Size = { w: 1280, h: 720 }

/** How long the page takes to come back from the rubber: quick enough to read as a snap. */
const SETTLE_MS = 240

/** How far a press may wander before it reads as a drag: under this it is still a press. */
const PAN_SLOP = 4

/**
 * The curve the page comes back on: an ease-out that runs a few percent past its rest and settles.
 * A cut straight back to the edge reads as the pointer having been let go of; a little overshoot
 * reads as the page having been pulled.
 */
function settleAt(t: number): number {
  const left = t - 1
  return 1 + left * left * (2 * left + 1)
}

/** What one press on a card may do: `targetOf` says where it goes, `open` takes it there. */
export interface CardGo {
  targetOf(node: NodeReading): string | null
  open(target: string): void
}

type Mode = 'fit' | 'focus' | 'free'

export function MapPane(props: {
  readonly active: boolean
  readonly noNodes: boolean
  readonly project: ProjectReading | null
  readonly go: CardGo | null
  /** The stranded dispatches, by node id: the line each cell's claim belongs to. */
  readonly stranded: Readonly<Record<string, string>>
  /** Read the record again: the page's own reading is fixed until this lands. */
  readonly onRefresh: () => void
}): React.ReactElement {
  const t = useT()
  const field = React.useRef<HTMLDivElement | null>(null)
  const view = React.useRef<View>({ s: 1, tx: 0, ty: 0 })
  const dragged = React.useRef(false)
  const panning = React.useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean; captured: boolean } | null>(null)
  /* Which finger the touch pan belongs to: a second finger landing mid-pan must not steal it, and
   * the id has to live through the listener effect re-subscribing under a moving hand. */
  const touchId = React.useRef<number | null>(null)
  /* A pinch in flight: the two fingers it belongs to, and where the camera and the fingers stood
   * when it began — every move scales that origin by the spread and carries it by the midpoint. */
  const pinch = React.useRef<{
    a: number
    b: number
    dist: number
    mid: { x: number; y: number }
    s: number
    tx: number
    ty: number
    moved: boolean
  } | null>(null)
  /* The frame of the bounce-back: cancelled by any new gesture, so a wheel or a second drag never
     fights the one in flight. */
  const settling = React.useRef<number | null>(null)
  const [size, setSize] = React.useState<Size>(FALLBACK)
  const [camera, setCamera] = React.useState<View>(view.current)
  /* The page opens at the focus: the card the triage puts first, with the ring it owes and is owed
   * by in view. The magnifier gives the overview from there, and another press brings the camera
   * back — so the reader starts where someone is wanted and steps back to the shape on purpose. */
  const [mode, setMode] = React.useState<Mode>('focus')
  /* Whether a drag is in flight: only the cursor changes, so the reader knows the page is moving
   * under the pointer rather than the drawing having jumped. */
  const [grabbing, setGrabbing] = React.useState(false)
  const [scope, setScope] = React.useState<string | null>(null)
  const [focusId, setFocusId] = React.useState<string | null>(null)

  const nodes = props.project?.nodes ?? []
  const edges = props.project?.graph.edges ?? []
  const head = React.useMemo(() => rankedOf(nodes)[0]?.id ?? null, [nodes])
  /* A scope the record no longer has (the line was deleted elsewhere) reads as the whole workspace
     rather than as nothing: the rail simply no longer offers it. */
  const liveScope = props.project !== null && props.project.cycles.some((cycle) => cycle.id === scope) ? scope : null

  /* The focus follows the record: on the first read it lands on the head, and when the card in focus
     is no longer in the record it lands there again. A refresh that still holds the focused card
     leaves the camera exactly where the reader put it. */
  React.useLayoutEffect(() => {
    if (focusId !== null && nodes.some((node) => node.id === focusId)) return
    setFocusId(head)
    setScope(null)
  }, [nodes, focusId, head])

  const placement = React.useMemo(
    () => place({ nodes, edges, cap: CAP, focus: focusId }),
    [nodes, edges, focusId],
  )
  const emphasis = React.useMemo(() => emphasisOf(placement, focusId, liveScope), [placement, focusId, liveScope])

  const commit = React.useCallback((next: View): void => {
    view.current = next
    setCamera(next)
  }, [])

  const stopSettle = React.useCallback((): void => {
    if (settling.current === null) return
    cancelAnimationFrame(settling.current)
    settling.current = null
  }, [])

  /* A pull past the edge is let go of, not cut: the camera runs back to where {@link panView} holds it,
   * overshooting the rest by a few percent. The rest is a hard edge only in the sense that it is where
   * the page stops once the spring has settled. */
  const springBack = React.useCallback((rest: View): void => {
    stopSettle()
    const from = view.current
    const dx = rest.tx - from.tx
    const dy = rest.ty - from.ty
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      commit(rest)
      return
    }
    const started = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / SETTLE_MS)
      const k = settleAt(t)
      commit({ s: from.s, tx: from.tx + dx * k, ty: from.ty + dy * k })
      if (t < 1) {
        settling.current = requestAnimationFrame(step)
        return
      }
      settling.current = null
      commit(rest)
    }
    settling.current = requestAnimationFrame(step)
  }, [commit, stopSettle])

  React.useEffect(() => stopSettle, [stopSettle])

  const measure = React.useCallback((): void => {
    const held = field.current
    if (held === null) return
    const rect = held.getBoundingClientRect()
    setSize({ w: rect.width > 0 ? rect.width : FALLBACK.w, h: rect.height > 0 ? rect.height : FALLBACK.h })
  }, [])

  /* The viewport is measured when this pane becomes visible: behind another tab there is no layout
     to measure, and measuring 0 would put the whole drawing at the origin. */
  React.useLayoutEffect(() => {
    if (props.active) measure()
  }, [props.active, measure])

  React.useEffect(() => {
    const onResize = (): void => {
      if (props.active) measure()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [props.active, measure])

  /* The camera is derived, not stored per gesture: an overview is re-fitted whenever the drawing or
     the viewport changes, a focus camera is re-aimed whenever the focus moves, and a camera the
     reader moved themselves is only ever held inside {@link panBounds}. A drag in flight and its
     bounce-back are the reader's own doing, so this leaves those two alone. */
  React.useLayoutEffect(() => {
    if (props.project === null) return
    if (mode === 'fit') {
      stopSettle()
      commit(fitView(size, placement))
    } else if (mode === 'focus') {
      stopSettle()
      commit(focusView(size, placement, focusId))
    } else if (panning.current === null && pinch.current === null && settling.current === null) commit(panView(view.current, size, placement))
  }, [props.project, placement, mode, focusId, size, commit, stopSettle])

  /* The wheel zooms around the pointer: a listener of its own, because the page must not scroll
     under the drawing and React's own wheel handler cannot cancel it. */
  React.useEffect(() => {
    const held = field.current
    if (held === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return
      event.preventDefault()
      stopSettle()
      const rect = held.getBoundingClientRect()
      const next = zoomAt(view.current, { x: event.clientX - rect.left, y: event.clientY - rect.top }, view.current.s * Math.exp(-event.deltaY * 0.0015))
      commit(panView(next, size, placement))
      setMode('free')
    }
    held.addEventListener('wheel', onWheel, { passive: false })
    return () => held.removeEventListener('wheel', onWheel)
  }, [commit, size, placement, props.active, stopSettle])

  /* One press, one pan — the same arithmetic whichever hand holds it. The press records where the
   * camera stood; a move that clears the slop carries the page; the release runs it back to its
   * rest. A touch arrives by its own road (see the touch listeners below) and lands here too. */
  const beginPan = React.useCallback((x: number, y: number): void => {
    stopSettle()
    panning.current = { x, y, tx: view.current.tx, ty: view.current.ty, moved: false, captured: false }
    dragged.current = false
  }, [stopSettle])

  const dragPan = React.useCallback((x: number, y: number): void => {
    const held = panning.current
    if (held === null) return
    const dx = x - held.x
    const dy = y - held.y
    if (!held.moved && Math.abs(dx) + Math.abs(dy) < PAN_SLOP) return
    held.moved = true
    dragged.current = true
    setGrabbing(true)
    /* Past the edge the pointer still moves the page a little — the rubber takes the rest of the pull
       — so the drawing does not stop dead under the hand. */
    commit(rubberView({ s: view.current.s, tx: held.tx + dx, ty: held.ty + dy }, size, placement))
    setMode('free')
  }, [commit, size, placement])

  const endPan = React.useCallback((): void => {
    if (panning.current === null) return
    panning.current = null
    setGrabbing(false)
    const rest = panView(view.current, size, placement)
    if (rest !== view.current) springBack(rest)
  }, [size, placement, springBack])

  /* The touch half of the pan and the whole pinch, on listeners of their own. A finger also drives
   * pointer events, but on iPad Safari that road ends a few moves in: the browser hands the moving
   * finger to its own gesture and cancels the pointer — `touch-action: none` asks it not to, and
   * the asking goes unheard — while the capture a drag past the edge needs is not there to take. So
   * the finger is met where WebKit holds the contract: a non-passive `touchmove` whose default is
   * prevented never becomes a page scroll or a page pinch, and touch events keep arriving at the
   * element the press began on for the whole gesture, no capture involved. A tap still reaches the
   * cards: a tap sends no `touchmove`, and `touchend` is never prevented, so the click is
   * synthesized as usual. */
  React.useEffect(() => {
    const held = field.current
    if (held === null) return undefined
    const fingerOf = (event: TouchEvent, id: number): Touch | null => {
      for (const touch of event.touches) {
        if (touch.identifier === id) return touch
      }
      return null
    }
    const owned = (event: TouchEvent): Touch | null => (touchId.current === null ? null : fingerOf(event, touchId.current))
    const lifted = (event: TouchEvent): Touch | null => {
      if (touchId.current === null) return null
      for (const touch of event.changedTouches) {
        if (touch.identifier === touchId.current) return touch
      }
      return null
    }
    /* The beat a pinch starts from: the two fingers and the camera, read at the same moment. */
    const pinchFrom = (a: Touch, b: Touch): void => {
      stopSettle()
      pinch.current = {
        a: a.identifier,
        b: b.identifier,
        dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
        mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
        s: view.current.s,
        tx: view.current.tx,
        ty: view.current.ty,
        moved: false,
      }
      panning.current = null
    }
    const pinchEnd = (): void => {
      pinch.current = null
      touchId.current = null
      setGrabbing(false)
    }
    const onTouchStart = (event: TouchEvent): void => {
      if (pinch.current !== null) return
      if (panning.current !== null) {
        /* A second finger joins a pan in flight: the pan hands the camera over to a pinch, wherever
         * the joining finger landed — the field already owns this gesture. */
        const a = owned(event)
        let joined: Touch | null = null
        for (const touch of event.changedTouches) {
          if (touch.identifier !== touchId.current) { joined = touch; break }
        }
        if (a !== null && joined !== null) pinchFrom(a, joined)
        return
      }
      if ((event.target as Element).closest('.pf-tools') !== null) return
      const first = event.changedTouches[0]
      if (first === undefined) return
      touchId.current = first.identifier
      beginPan(first.clientX, first.clientY)
      /* Two fingers landing on one beat start a pinch straight away rather than a pan. */
      let second: Touch | null = null
      for (const touch of event.changedTouches) {
        if (touch.identifier !== first.identifier) { second = touch; break }
      }
      if (second !== null) pinchFrom(first, second)
    }
    const onTouchMove = (event: TouchEvent): void => {
      const origin = pinch.current
      if (origin !== null) {
        const a = fingerOf(event, origin.a)
        const b = fingerOf(event, origin.b)
        if (a === null || b === null) {
          /* A finger of the pinch is gone: the gesture is over, not paused. The finger left down
           * waits for a fresh press rather than turning into a drag mid-air. */
          pinchEnd()
          return
        }
        /* Every move is held from the first one, the same as a pan's: an unprevented move is the
         * browser's own scroll or page pinch begun, and the gesture loses the fingers to it. */
        event.preventDefault()
        const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
        /* The spread scales the camera around the fingers' midpoint, and the midpoint's own travel
         * carries the page: the one gesture a wheel and a drag split in two on the desk. */
        commit(panView(zoomAt({ s: origin.s, tx: origin.tx + mid.x - origin.mid.x, ty: origin.ty + mid.y - origin.mid.y }, mid, origin.s * (dist / origin.dist)), size, placement))
        if (!origin.moved) {
          origin.moved = true
          dragged.current = true
          setMode('free')
        }
        return
      }
      const touch = owned(event)
      if (touch === null) return
      event.preventDefault()
      dragPan(touch.clientX, touch.clientY)
    }
    const onTouchEnd = (event: TouchEvent): void => {
      const origin = pinch.current
      if (origin !== null) {
        for (const touch of event.changedTouches) {
          if (touch.identifier === origin.a || touch.identifier === origin.b) {
            pinchEnd()
            return
          }
        }
        return
      }
      if (lifted(event) === null) return
      touchId.current = null
      endPan()
    }
    /* Safari announces a page pinch as its own gesture before the touches say a word: refusing it
     * here is what keeps two fingers on the drawing from zooming the whole document. The event is
     * Safari's own, so it is taken as the plain kind. */
    const onPagePinch = (event: Event): void => { event.preventDefault() }
    held.addEventListener('touchstart', onTouchStart, { passive: false })
    held.addEventListener('touchmove', onTouchMove, { passive: false })
    held.addEventListener('touchend', onTouchEnd)
    held.addEventListener('touchcancel', onTouchEnd)
    held.addEventListener('gesturestart', onPagePinch)
    return () => {
      held.removeEventListener('touchstart', onTouchStart)
      held.removeEventListener('touchmove', onTouchMove)
      held.removeEventListener('touchend', onTouchEnd)
      held.removeEventListener('touchcancel', onTouchEnd)
      held.removeEventListener('gesturestart', onPagePinch)
    }
  }, [beginPan, dragPan, endPan, commit, size, placement, stopSettle])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    /* A touch presses by the touch listeners' road as well: its pointer twin must not re-anchor the
     * pan (a second finger landing would move the anchor out from under the first). */
    if (event.pointerType === 'touch') return
    if ((event.target as Element).closest('.pf-tools') !== null) return
    beginPan(event.clientX, event.clientY)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch') return
    const held = panning.current
    if (held === null) return
    const dx = event.clientX - held.x
    const dy = event.clientY - held.y
    if (!held.moved && Math.abs(dx) + Math.abs(dy) < PAN_SLOP) return
    if (!held.moved && !held.captured && typeof event.currentTarget.setPointerCapture === 'function') {
      /* The pointer is taken only once this is a drag: a plain press on a card stays a press, and a
       * drag that runs past the field's edge — a quick throw, or a slide over the rail — keeps moving
       * the page instead of stopping halfway. */
      held.captured = true
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        /* The pointer is no longer there to take: the drag still moves, it just stops at the edge. */
        held.captured = false
      }
    }
    dragPan(event.clientX, event.clientY)
  }

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    /* A touch ends by its own road too: its trailing pointer events — the leave as the finger slides
     * out of the field, the up after the touch already ended — must not cut a pan the touch
     * listeners are still carrying, or that the browser has already cancelled. */
    if (event.pointerType === 'touch') return
    if (panning.current !== null && panning.current.captured) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        /* The pointer was already gone: nothing was captured, nothing to give back. */
      }
    }
    endPan()
  }

  /** One press on a card: the first comes close to it, and the press after that goes to its session. */
  const press = (node: NodeReading): void => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    /* A card already in focus while the page stands on the overview: the press is still "come look
     * at this one", so it takes the camera there rather than doing nothing. */
    if (focusId !== node.id || mode !== 'focus') {
      setFocusId(node.id)
      setMode('focus')
      return
    }
    const target = props.go?.targetOf(node) ?? null
    if (target !== null) props.go?.open(target)
  }

  /* Pressing a row picks the scope to search under and, with it, the card to stand on: the row's own
   * default — the card the triage puts first inside that scope. This is also the page's way back, so
   * it sets the mode outright: a camera the reader had dragged or zoomed off the focus comes back to
   * that scope's first card, and no reset button of its own is needed. */
  const pickScope = (id: string | null): void => {
    setScope(id)
    /* Which cards belong to a line is the model's one answer (`belongsTo`), the same one the detail's
     * sections and the ink are read from. */
    const pool = id === null ? nodes : nodes.filter((node) => belongsTo(node, id))
    const next = rankedOf(pool)[0]?.id ?? head
    setFocusId(next)
    setMode('focus')
  }

  const lod = lodOf(camera.s)
  const canvasStyle: React.CSSProperties = {
    width: `${String(placement.width)}px`,
    height: `${String(placement.height)}px`,
    transform: `translate(${String(camera.tx)}px, ${String(camera.ty)}px) scale(${String(camera.s)})`,
    ['--s' as string]: String(camera.s),
  }

  return (
    <PaneFrame id="map" active={props.active} noNodes={props.noNodes} className="pf-map-pane">
      <div
        className="pf-map"
        style={{ ['--card-w' as string]: `${String(CARD_W)}px`, ['--card-h' as string]: `${String(CARD_H)}px` }}
      >
        <aside className="pf-rail" role="group" aria-label={t('map.scope.aria')}>
          <RailItem label={t('common.global')} cycle={null} pressed={liveScope === null} onPress={() => pickScope(null)} />
          {(props.project?.cycles ?? []).map((cycle) => (
            <RailItem
              key={cycle.id}
              label={cycle.id}
              cycle={cycle}
              pressed={liveScope === cycle.id}
              /* A line that has touched nothing in this workspace is greyed out and holds no press:
                 the row itself is the reading — this line has done nothing here. */
              disabled={!nodes.some((node) => belongsTo(node, cycle.id))}
              onPress={() => pickScope(cycle.id)}
            />
          ))}
        </aside>

        <div
          className={`pf-field is-lod-${lod}${grabbing ? ' is-panning' : ''}${liveScope === null ? '' : ' is-scoped'}`}
          ref={field}
          role="region"
          aria-label={t('map.region.aria')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={onPointerEnd}
        >
          <div className="pf-canvas" style={canvasStyle}>
            <svg className="pf-wires" width={placement.width} height={placement.height} aria-hidden="true">
              <g>
                {edges
                  .filter((edge) => placement.pos[edge.from] !== undefined && placement.pos[edge.to] !== undefined)
                  .map((edge) => (
                    <path
                      key={`${edge.from}:${edge.to}`}
                      className={`pf-mwire${emphasis.lit.has(edge.from) && emphasis.lit.has(edge.to) ? ' is-lit' : ''}`}
                      data-from={edge.from}
                      data-to={edge.to}
                      d={wirePath(placement.pos[edge.from] as { x: number; y: number }, placement.pos[edge.to] as { x: number; y: number })}
                    />
                  ))}
              </g>
            </svg>
            <div className="pf-mnodes">
              {placement.drawn.map((node) => {
                const at = placement.pos[node.id]
                if (at === undefined) return null
                return (
                  <Card
                    key={node.id}
                    node={node}
                    point={at}
                    lit={emphasis.lit.has(node.id)}
                    ahead={emphasis.ahead.has(node.id)}
                    focused={node.id === focusId}
                    go={props.go}
                    at={props.project === null ? new Date() : props.project.at}
                    t={t}
                    dead={props.stranded[node.id] ?? null}
                    onPress={() => press(node)}
                  />
                )
              })}
            </div>
          </div>

          <div className="pf-tools">
            <button
              type="button"
              className="pf-tool"
              id="map-fit"
              aria-pressed={mode === 'fit'}
              aria-label={t('map.overview.aria')}
              title={t('map.overview.aria')}
              onClick={() => setMode(mode === 'fit' ? 'focus' : 'fit')}
            >
              <svg viewBox="0 0 15 15" aria-hidden="true">
                <circle cx="6.6" cy="6.6" r="4.1" />
                <path d="M9.7 9.7 L13.2 13.2" />
              </svg>
            </button>
            <button
              type="button"
              className="pf-tool"
              id="map-refresh"
              aria-label={t('map.refresh.aria')}
              title={t('map.refresh.aria')}
              onClick={props.onRefresh}
            >
              <svg viewBox="0 0 15 15" aria-hidden="true">
                <path d="M2.8 7.6a4.8 4.8 0 1 1 1.5 3.4" />
                <path d="M2.8 3.6v4h4" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </PaneFrame>
  )
}

/** One row of the rail: a scope to search under, greyed out when this workspace holds nothing for it. */
function RailItem(props: {
  readonly label: string
  /** The line this row stands for; the whole-workspace row has none, and draws no mark. */
  readonly cycle: CycleReading | null
  readonly pressed: boolean
  readonly disabled?: boolean | undefined
  readonly onPress: () => void
}): React.ReactElement {
  const t = useT()
  return (
    <button
      type="button"
      className="pf-rail-item"
      aria-pressed={props.pressed}
      aria-label={props.cycle === null ? props.label : `${props.label} · ${stateWord(t, props.cycle)}`}
      disabled={props.disabled === true}
      onClick={props.onPress}
    >
      {/* Every row holds the mark's cell open, drawing in it or not: that is what puts this column's
          names on the same edge as the detail pane's. The whole-workspace row reads no line, so its
          cell stands empty. */}
      {props.cycle === null ? <span className="pf-linemark" /> : <LineMark cycle={props.cycle} />}
      <span className="pf-cycle">{props.label}</span>
    </button>
  )
}

/**
 * One card: its title, then the row that says which lines it belongs to and when, with the running
 * ring leading that row on the one card that is in hand.
 *
 * A card carries two readings at once and they must not borrow each other's paint: the frame says
 * what state the cell is in, the ground and the title's ink say whether this is the card the reader
 * is looking at. Once a line is picked the frame leaves every card outside that line — so the rank
 * between "this line", "no line yet" and "another line" is carried by ground and ink alone.
 */
function Card(props: {
  readonly node: NodeReading
  readonly point: { readonly x: number; readonly y: number }
  readonly lit: boolean
  /** A card in the picked line's future: one step below lit, and never framed. */
  readonly ahead: boolean
  readonly focused: boolean
  readonly go: CardGo | null
  /** The moment the reading was taken: every stamp on this page is read against it. */
  readonly at: Date
  readonly t: Translate
  /** The line this card's stranded claim belongs to, when the round is out with nothing moving it. */
  readonly dead: string | null
  readonly onPress: () => void
}): React.ReactElement {
  const { node, t } = props
  const target = props.go === null ? null : props.go.targetOf(node)
  const hover = nodeHover(node)
  const canGo = target !== null
  const moment = node.stampAt
  const dead = props.dead !== null && props.dead.length > 0
  /* The lines this cell belongs to, in the model's own order: every line that has walked it (a
   * re-run included) first, then any line holding it now. */
  const owners = ownersOf(node)
  return (
    <button
      type="button"
      className={`pf-mnode ${edgeOf(node)}${dead ? ' is-dead' : ''}${props.lit ? ' is-lit' : ''}${!props.lit && props.ahead ? ' is-ahead' : ''}`}
      data-id={node.id}
      style={{ left: `${String(props.point.x)}px`, top: `${String(props.point.y)}px` }}
      title={props.focused && canGo ? `${hover} · ${t('map.card.go')}` : hover}
      aria-label={t('map.card.aria', { node: hover })}
      onClick={props.onPress}
    >
      <span className="pf-mtitle">{nodeName(node)}</span>
      <span className="pf-mmeta">
        {/* The mark leads the row: a round in hand wears the ring, and one whose session is gone
            wears the stranded × in its place — the same slot, because it is the same reading (what
            is happening to this cell right now). The lines' ids follow, in the order the model gives
            them (`ownersOf`: every line that walked this cell, then any line holding it), and a card
            no line has touched renders no id at all rather than an empty one — nothing is drawn for
            what the record does not have. */}
        {node.running
          ? (dead
            ? <StrandedMark cycleId={props.dead} nodeId={node.id} />
            : <span className="pf-state is-run" title={runningTitle(t, node)} />)
          : null}
        {owners.length === 0 ? null : <span className="pf-mtag">{owners.join('·')}</span>}
        {node.gate === null ? null : <span className="pf-gate">{gateWord(t, node.gate)}</span>}
        <span className="pf-mtime pf-num">{moment === null ? '' : timeOf(t, moment, props.at)}</span>
      </span>
    </button>
  )
}

/**
 * What the frame says: the model's one bucket, worn as a class. The gate outranks everything, and
 * the model says so once; a shelved card keeps the gate frame too, because its verdict is a wait
 * for a person and amber is that wait's colour.
 */
export function edgeOf(node: NodeReading): string {
  const bucket = bucketOf(node)
  return bucket === 'run' ? 'is-run'
    : bucket === 'done' ? 'is-done'
      : bucket === 'todo' ? 'is-todo'
        : 'is-gate'
}