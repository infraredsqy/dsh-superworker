/**
 * The widgets shared by the client's panes: a movable split, a count pill, a modal shell, a
 * commit-style input, and the pane shell every view stands in.
 *
 * Each exists only once: the drag measurement differs in three places, but draggable + keyboard +
 * double-click-to-default is written down in one way; the modal's overlay, Escape, and focus all
 * come from one place, with each pane contributing only its body; and the pane shell's tab wiring
 * and "no record yet" sentence are stated once for the five views.
 */
import * as React from 'react'
import { NOT_ENABLED_WORD } from './constants.ts'
import { useT } from './locale.ts'

/**
 * The shell every pane stands in: one tabpanel per view, its `id` and `aria-labelledby` derived from
 * the view id the tab row uses, and the "this workspace has no record yet" sentence in place of the
 * body.
 *
 * @param props - The view id (`map`, `detail`, `notes`, `issue`, `config` — the tab row's own ids),
 *   whether the pane is the visible one, whether the workspace has no node record at all, what this
 *   pane's own sheet hangs on it beyond `superworker-pane`, whether it fills the frame's footprint, a region
 *   name for panes whose head is not their label, and the body.
 */
export function PaneFrame(props: {
  readonly id: string
  readonly active: boolean
  readonly noNodes: boolean
  /** Further classes this pane's own sheet selects on, e.g. the map's or the issue pane's. */
  readonly className?: string | undefined
  /** Every pane but the map fills the frame's footprint. */
  readonly fill?: boolean | undefined
  /** An extra region name, for the panes whose head is not the only thing naming them. */
  readonly ariaLabel?: string | undefined
  readonly children?: React.ReactNode
}): React.ReactElement {
  const t = useT()
  return (
    <section
      className={`superworker-pane${props.className === undefined ? '' : ` ${props.className}`}`}
      id={`pane-${props.id}`}
      role="tabpanel"
      aria-labelledby={`tab-${props.id}`}
      aria-label={props.ariaLabel}
      data-fill={props.fill === true ? '' : undefined}
      hidden={!props.active}
    >
      {props.noNodes ? <p className="superworker-innone">{t(NOT_ENABLED_WORD)}</p> : props.children}
    </section>
  )
}

/**
 * A movable split: pointer dragging, keyboard stepping, double-click-to-default, and the aria value
 * all live in this one file; the three call sites (detail sidebar, settings column, issue-pool
 * split) contribute only their own measurement and bounds.
 *
 * Measurement is captured in two gains and one clamp: how much one pointer pixel changes the value
 * (`dragGain`), how much one arrow-key step changes it (`keyGain`, signed — it says which side's
 * edge is being moved); the computed number then passes through the caller's `clamp` onto the
 * bounds. Keyboard is ArrowLeft / ArrowRight for one step, Shift for a big step, Home / End for the
 * two ends.
 */
export function Grip(props: {
  readonly label: string
  readonly value: number
  /** The two ends reported over aria; keyboard Home / End also lands here. */
  readonly min: number
  readonly max: number
  /** The bounds: where the computed value lands — rounding and limits both happen in this hand. */
  readonly clamp: (px: number) => number
  readonly step: number
  /** How much the value changes per pointer pixel; default 1. The settings pair is ±2: one edge moving Δ changes the width by 2Δ with the center fixed. */
  readonly dragGain?: number
  /** How much one arrow-key step changes the value; default 1. */
  readonly keyGain?: number
  /** The big step while Shift is held; two steps when absent. */
  readonly bigStep?: number
  readonly onChange: (px: number) => void
  /** The commit on release and double-click; changes only, no commit, when absent. */
  readonly onCommit?: (px: number) => void
  /** The value a double-click returns to; no double-click move when absent. */
  readonly resetTo?: number
  /** The marker for the drag breath; the issue pool uses it to hang is-dragging on the page. */
  readonly onDragging?: (dragging: boolean) => void
  readonly className?: string
  readonly id?: string
  readonly gripRef?: React.Ref<HTMLDivElement>
}): React.ReactElement {
  const { value, clamp, onChange } = props
  const from = React.useRef(0)
  const base = React.useRef(value)
  return (
    <div
      className={props.className ?? 'superworker-grip'}
      id={props.id}
      ref={props.gripRef}
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-label={props.label}
      aria-valuenow={value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      onPointerDown={(event) => {
        from.current = event.clientX
        base.current = value
        /* Synthetic events carry no real pointer: failing to capture is not an error — that gesture was never a drag. */
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch (error) {
          from.current = event.clientX
        }
        props.onDragging?.(true)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const moved = clamp(base.current + (props.dragGain ?? 1) * (event.clientX - from.current))
        if (moved !== value) onChange(moved)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        props.onDragging?.(false)
        props.onCommit?.(value)
      }}
      onPointerCancel={() => props.onDragging?.(false)}
      onDoubleClick={() => {
        if (props.resetTo === undefined) return
        onChange(props.resetTo)
        props.onCommit?.(props.resetTo)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Home') {
          event.preventDefault()
          onChange(clamp(props.min))
          return
        }
        if (event.key === 'End') {
          event.preventDefault()
          onChange(clamp(props.max))
          return
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const pace = event.shiftKey ? (props.bigStep ?? props.step * 2) : props.step
        const toward = event.key === 'ArrowRight' ? 1 : -1
        onChange(clamp(value + (props.keyGain ?? 1) * pace * toward))
      }}
    />
  )
}

/** A count pill: which state, how many. The combined one for uncategorized states carries no empty-state class. */
export function Pill(props: { readonly cls: string; readonly n: number; readonly label: string }): React.ReactElement {
  return (
    <span className="superworker-pill" title={props.label}>
      <i className={`superworker-cell${props.cls.length === 0 ? '' : ` ${props.cls}`}`} />
      <b className="superworker-num">{`× ${String(props.n)}`}</b>
    </span>
  )
}

/**
 * A modal shell: one click on the overlay closes it, Escape closes it, and focus moves to the
 * shell on the mount beat.
 *
 * The listener's dependencies are narrowed to the single `onClose` value, instead of re-mounting
 * the whole props bundle on every render.
 */
export function ModalShell(props: {
  /** The title row's id: the dialog reports its name by it. */
  readonly labelId: string
  /** The title row's text. */
  readonly name: string
  /** The sentence shown on name hover; no hover attached when absent. */
  readonly nameTitle?: string
  readonly onClose: () => void
  readonly children: React.ReactNode
}): React.ReactElement {
  const t = useT()
  const { onClose } = props
  const panel = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    panel.current?.focus()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="superworker-modal" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="superworker-modal-panel" role="dialog" aria-modal="true" aria-labelledby={props.labelId} ref={panel} tabIndex={-1}>
        <div className="superworker-modal-head">
          <span className="superworker-modal-name" id={props.labelId} title={props.nameTitle}>{props.name}</span>
          <button type="button" className="superworker-mini" onClick={onClose}>{t('common.close')}</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

/**
 * A commit-style input: type=number by default (the line's policy fields), type=text for the
 * settings page's unregistered keys; both blur and Enter count as done; typed characters live in
 * the box and yield only when a reading arrives.
 *
 * The box's text must survive a commit: blur and Enter often arrive back to back (focus moving away
 * on the commit beat is routine), and handing over unaccepted characters as empty would make the
 * write side replace a just-recorded entry with "not set". Only when the reading's value changes
 * (written then read back, or changed elsewhere) does the box swap to the reading's copy. The commit
 * rule is supplied by the caller: this file only hands over the trimmed text — whether to write,
 * and what, is its call.
 *
 * The "unset" placeholder — worn when the reading holds no value — is spelled from the dictionary
 * like every other word here (`common.unset`).
 */
export function CommitNumberInput(props: {
  /** How the reading's value prints; the box starts from it and returns to it. */
  readonly held: string
  /** The reading has no such value: the box wears is-unset and the placeholder says "unset". */
  readonly unset: boolean
  /** `number` (with the count floor) unless the caller says otherwise; the settings page's text rows say `text`. */
  readonly type?: 'number' | 'text'
  /** Handed to the input as-is; the text rows turn the browser's spellcheck off. */
  readonly spellCheck?: boolean
  readonly label: string
  readonly describedBy: string
  /** The reading's marker: once it flips, the box swaps to the reading's copy. Without it the box follows `held` only. */
  readonly revision?: number
  readonly title?: string
  readonly onCommit: (text: string) => void
}): React.ReactElement {
  const t = useT()
  const [text, setText] = React.useState(props.held)
  React.useEffect(() => { setText(props.held) }, [props.held, props.revision])
  const commit = (): void => {
    props.onCommit(text.trim())
  }
  return (
    <input
      className={`superworker-numin${props.unset ? ' is-unset' : ''}`}
      type={props.type ?? 'number'}
      min={props.type === 'text' ? undefined : 1}
      spellCheck={props.spellCheck}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      placeholder={props.unset ? t('common.unset') : ''}
      value={text}
      title={props.title}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        commit()
      }}
    />
  )
}
