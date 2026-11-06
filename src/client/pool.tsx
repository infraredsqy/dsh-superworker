/**
 * The issues pane: how a ledger reads — the list on the left, one case on the right, and the reader
 * may move the split in between.
 *
 * One page answers one question: what is still owed. So it opens on "unresolved", and "full" puts
 * the other three states back. The weight gauge is the drawing of these weights; entries below the
 * line take no slots — whether one presses the line is said by the reading itself, the same
 * standard as the weighted sum. When the record has no weight table or no policy line, the gauge is
 * not drawn at all rather than standing in with a 0.
 */
import * as React from 'react'
import type { IssueGroupReading, IssueReading, PoolReading, ProjectReading } from '../model/index.ts'
import { useT } from './locale.ts'
import { issueWord, otherStatesWord } from './words.ts'
import { NOT_ENABLED_WORD } from './constants.ts'
import { Grip, Pill } from './widgets.tsx'

/** How many pixels one weight unit occupies, and the gap between two units. */
const SLOT = 6
const SLOTS = 2

/** Each half's minimum width: the left is three columns around a sentence, the right is one passage. */
const POOL_MIN = 320
const CASE_MIN = 360
/** How far one keyboard move of the split travels. */
const BAR_STEP = 16

/**
 * The tier the record itself names, worn as a class. The list of tiers and the lightest one are the
 * model's (`pool.ts`'s weight table); this side only spells the word the record already wrote. A
 * case whose record names no tier draws no badge at all, so there is nothing here to stand in with
 * a default — inventing one would put a tier on the screen that the record never said.
 */
function sevClass(severity: string | undefined): string {
  return severity === undefined ? '' : `is-${severity}`
}

/** The severity badge: one word, its weight on hover; absent when the record names no severity. */
function SevChip(props: { readonly issue: IssueReading }): React.ReactElement | null {
  const t = useT()
  const { issue } = props
  if (issue.severity === undefined) return null
  return (
    <span
      className={`pf-sev ${sevClass(issue.severity)}`}
      title={t('pool.severity.tip', { severity: issue.severity, weight: issue.weight })}
    >
      {issue.severity}
    </span>
  )
}

export function IssuePool(props: {
  readonly project: ProjectReading
  readonly showOtherStates: boolean
  readonly onShowOtherStates: (on: boolean) => void
}): React.ReactElement {
  const t = useT()
  const { pool } = props.project
  const [picked, setPicked] = React.useState<string | null>(null)
  const [folds, setFolds] = React.useState<Readonly<Record<string, boolean>>>({})
  const splitRef = React.useRef<HTMLDivElement | null>(null)
  const gutterRef = React.useRef<HTMLDivElement | null>(null)
  const [left, setLeft] = React.useState<number | null>(null)
  const [bar, setBar] = React.useState({ min: POOL_MIN, max: POOL_MIN, now: POOL_MIN })
  /* The moment a drag is under way: this state hangs on the pane itself (not the page root), and three stylesheet rules follow it. */
  const [dragging, setDragging] = React.useState(false)

  const openGroup = pool.groups.find((group) => group.key === 'open')
  const closedGroups = pool.groups.filter((group) => group.key !== 'open')
  /* One case must be selected as soon as the pane shows: open first; only when there is none (the
     record settled everything) fall to the set-aside piles. */
  const fallback = openGroup?.entries[0]
    ?? (props.showOtherStates
      ? closedGroups.find((group) => group.key === 'acknowledged')?.entries[0]
        ?? closedGroups.find((group) => group.key === 'resolved')?.entries[0]
        ?? closedGroups.find((group) => group.key === 'rejected')?.entries[0]
      : undefined)
  const selected = pool.rows.find((row) => row.id === picked
    && (row.status === 'open' || props.showOtherStates)) ?? fallback ?? null

  /* How much room each half takes: the stylesheet's own copy until the reader moves it, then pinned at the moved position. */
  const barAt = React.useCallback(() => {
    const split = splitRef.current
    const gutter = gutterRef.current
    if (split === null || gutter === null) return { now: POOL_MIN, max: POOL_MIN }
    const box = split.getBoundingClientRect()
    const handle = gutter.getBoundingClientRect()
    return {
      now: Math.round(handle.left - box.left),
      max: Math.max(POOL_MIN, Math.round(box.width - handle.width - CASE_MIN)),
    }
  }, [])

  const paintBar = React.useCallback(() => {
    const at = barAt()
    setBar({ min: POOL_MIN, max: at.max, now: left === null ? at.now : left })
  }, [barAt, left])

  /* That row of numbers reports accurately only when measured: a window resize or the pane just
     becoming visible both trigger a re-measure. If the moved split got squeezed out of range by the
     window, pull it back. */
  React.useEffect(() => {
    const onResize = (): void => {
      const at = barAt()
      if (left !== null && at.now > at.max) setLeft(at.max)
      else paintBar()
    }
    paintBar()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [paintBar, barAt, left])

  /* The split's bounds: where the computed position lands — the left half's floor and the pane's
     currently measured ceiling are both decided in this hand. */
  const clampBar = (to: number): number => {
    const at = barAt()
    return Math.max(POOL_MIN, Math.min(Math.round(to), at.max))
  }

  /* Arrow keys move to the next row; the picked row is the one on the right half. */
  const select = (id: string): void => {
    setPicked(id)
  }

  const onRegisterKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const rows = [...(event.currentTarget.querySelectorAll('button.pf-row[data-issue]'))] as HTMLElement[]
    if (rows.length === 0) return
    const at = rows.indexOf(event.target as HTMLElement)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = rows[at + 1] ?? rows[0]
    else if (event.key === 'ArrowUp') next = rows[at - 1] ?? rows[rows.length - 1]
    else if (event.key === 'Home') next = rows[0]
    else if (event.key === 'End') next = rows[rows.length - 1]
    if (next === undefined) return
    event.preventDefault()
    next.focus()
    const id = next.getAttribute('data-issue')
    if (id !== null) setPicked(id)
  }

  const foldOf = (group: IssueGroupReading): boolean => (
    folds[group.key] ?? (selected !== null && selected.status === group.key)
  )

  /* This pane follows only the issues reading: when it is absent (or holds no entries), the pane
   * collapses to one sentence — the same one the other five panes say. The ledger, the split between
   * the halves, and the "case" all speak what the record does not say about itself — nothing is
   * drawn for what does not exist. */
  if (pool.rows.length === 0) return <p className="pf-innone">{t(NOT_ENABLED_WORD)}</p>

  const splitStyle = left === null ? undefined : ({ ['--pf-left' as string]: `${String(left)}px` } as React.CSSProperties)

  return (
    <div className={`pf-page${dragging ? ' is-dragging' : ''}`}>
      <section className="pf-band">
        <div className="pf-seg" role="group" aria-label={t('pool.detail-level.aria')}>
          <button
            type="button"
            className="pf-segbtn"
            aria-pressed={!props.showOtherStates}
            title={t('pool.lean.tip', { state: issueWord(t, 'open'), count: pool.census.open })}
            onClick={() => props.onShowOtherStates(false)}
          >
            {t('pool.lean')}
          </button>
          <button
            type="button"
            className="pf-segbtn"
            aria-pressed={props.showOtherStates}
            title={otherStatesWord(t, pool)}
            onClick={() => props.onShowOtherStates(true)}
          >
            {t('pool.full')}
          </button>
        </div>
        {pool.weights === null || pool.line === null ? null : <Gauge pool={pool} />}
        <div className="pf-count">
          {pool.census.open > 0
            ? <Pill cls="is-open" n={pool.census.open} label={issueWord(t, 'open')} />
            : null}
          {props.showOtherStates
            ? (
              <React.Fragment>
                {pool.census.acknowledged > 0 ? <Pill cls="is-acknowledged" n={pool.census.acknowledged} label={issueWord(t, 'acknowledged')} /> : null}
                {pool.census.rejected > 0 ? <Pill cls="is-rejected" n={pool.census.rejected} label={issueWord(t, 'rejected')} /> : null}
                {pool.census.resolved > 0 ? <Pill cls="is-resolved" n={pool.census.resolved} label={issueWord(t, 'resolved')} /> : null}
              </React.Fragment>
            )
            : (pool.census.acknowledged + pool.census.rejected + pool.census.resolved > 0
              ? <Pill cls="" n={pool.census.acknowledged + pool.census.rejected + pool.census.resolved} label={otherStatesWord(t, pool)} />
              : null)}
        </div>
      </section>

      <div className="pf-split" id="split" style={splitStyle} ref={splitRef}>
        <div
          className="pf-register"
          id="register"
          role="region"
          aria-label={t('pool.scroll.aria')}
          tabIndex={0}
          onKeyDown={onRegisterKey}
        >
          {pool.groups.map((group) => {
            if (group.key !== 'open' && !props.showOtherStates) return null
            if (group.key === 'open') {
              return (
                <React.Fragment key={group.key}>
                  <RegisterHead group={group} />
                  {group.entries.map((entry) => (
                    <RegisterRow
                      key={entry.id}
                      issue={entry}
                      current={entry.id === selected?.id}
                      onPick={select}
                    />
                  ))}
                </React.Fragment>
              )
            }
            const open = foldOf(group)
            return (
              <React.Fragment key={group.key}>
                <RegisterHead group={group} />
                {open ? group.entries.map((entry) => (
                  <RegisterRow
                    key={entry.id}
                    issue={entry}
                    current={entry.id === selected?.id}
                    onPick={select}
                  />
                )) : null}
                <div className="pf-row">
                  <span className="pf-lead" />
                  <button
                    type="button"
                    className="pf-fold"
                    aria-expanded={open}
                    onClick={() => setFolds((table) => ({ ...table, [group.key]: !open }))}
                  >
                    {open ? t('common.collapse') : t('common.expand-more', { count: group.count })}
                  </button>
                  <span className="pf-mod" />
                </div>
              </React.Fragment>
            )
          })}
        </div>

        {/* The split between ledger and case: drag, keyboard, and aria all live on the shared Grip;
            here it is given only this pane's currently measured two ends. */}
        <Grip
          id="gutter"
          className="pf-gutter"
          label={t('pool.grip.aria')}
          value={bar.now}
          min={bar.min}
          max={bar.max}
          clamp={clampBar}
          step={BAR_STEP}
          gripRef={gutterRef}
          onChange={setLeft}
          onDragging={setDragging}
        />

        <aside className="pf-case" id="case" role="region" aria-label={t('pool.case.aria')} tabIndex={0}>
          {selected === null ? null : <CaseFile issue={selected} />}
        </aside>
      </div>
    </div>
  )
}

/** The weight gauge: one unit per slot, filled up to what is still owed, framed by the policy line. */
function Gauge(props: { readonly pool: PoolReading }): React.ReactElement {
  const t = useT()
  const { pool } = props
  const line = pool.line ?? 0
  const units = Math.max(line, pool.weight ?? 0)
  const blocks: { readonly severity: string | undefined; readonly carried: boolean; readonly title: string }[] = []
  for (const issue of pool.standing) {
    /* Entries below the line take no slot on this bar: whether one presses the line is said by the
       reading itself, the same standard as the weighted sum — they remain on the ledger, they just
       do not press on this line. */
    if (!issue.payable) continue
    for (let at = 0; at < issue.weight && blocks.length < units; at += 1) {
      blocks.push({
        severity: issue.severity,
        carried: issue.status === 'acknowledged',
        title: t('pool.weight.tip', {
          severity: issue.severity ?? '',
          weight: issue.weight,
          title: issue.title ?? '',
        }),
      })
    }
  }
  const [filled, setFilled] = React.useState(false)
  /* The pool fills into its own weight rather than appearing full: the stagger left by this re-read
     says "the same pool was counted once more". */
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setFilled(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <div className="pf-gauge" id="gauge" role="group" aria-label={t('pool.gauge.aria')}>
      <div
        className="pf-scale"
        id="scale"
        style={{ gap: `${String(SLOTS)}px`, gridTemplateColumns: `repeat(${String(units)}, ${String(SLOT)}px)` }}
      >
        {blocks.map((block, at) => (
          <i
            className={`pf-block ${sevClass(block.severity)}${block.carried ? ' is-carried' : ''}${filled && !block.carried ? ' is-fill' : ''}`}
            key={`b${String(at)}`}
            title={block.title}
            style={{ transitionDelay: `${String(Math.min(at, 24) * 6)}ms` }}
          />
        ))}
        {Array.from({ length: Math.max(0, units - blocks.length) }, (_, at) => (
          <i className="pf-block" key={`e${String(at)}`} />
        ))}
      </div>
      <i
        className="pf-line"
        style={{ left: `${String(line * (SLOT + SLOTS) - SLOTS)}px` }}
        title={t('pool.policy-line.tip', { value: line })}
      />
    </div>
  )
}

/** A pile on the ledger: how many in the side number, how heavy on the bar. */
function RegisterHead(props: { readonly group: IssueGroupReading }): React.ReactElement {
  const t = useT()
  return (
    <div className="pf-head">
      <span className="pf-lead" />
      <span className="pf-head-label">{issueWord(t, props.group.key)}</span>
    </div>
  )
}

function RegisterRow(props: {
  readonly issue: IssueReading
  readonly current: boolean
  readonly onPick: (id: string) => void
}): React.ReactElement {
  const { issue } = props
  return (
    <button
      type="button"
      className={`pf-row is-${issue.status}`}
      data-issue={issue.id}
      aria-current={props.current}
      onClick={() => props.onPick(issue.id)}
    >
      <span className="pf-lead">
        <i className={`pf-cell is-${issue.status}`} />
        <SevChip issue={issue} />
      </span>
      <span className="pf-title" title={issue.title ?? ''}>{issue.title ?? ''}</span>
      {issue.module === undefined ? null : <span className="pf-mod" title={issue.module}>{issue.module}</span>}
    </button>
  )
}

function CaseFile(props: { readonly issue: IssueReading }): React.ReactElement {
  const t = useT()
  const { issue } = props
  return (
    <React.Fragment>
      <div className="pf-case-head">
        <SevChip issue={issue} />
        <h2 className="pf-case-title">{issue.title ?? ''}</h2>
      </div>
      <span className="pf-case-id" title={issue.id}>{issue.id}</span>
      {issue.description === undefined ? null : <CaseSection label={t('pool.case.description')} body={prose(issue.description)} />}
      {issue.suggestion === undefined ? null : <CaseSection label={t('pool.case.suggestion')} body={prose(issue.suggestion)} />}
      {issue.files.length === 0 ? null : (
        <section className="pf-case-sec">
          <h3 className="pf-case-label">{t('pool.case.locations')}</h3>
          <ul className="pf-places">
            {issue.files.map((file) => <li className="pf-code" key={file} title={file}>{file}</li>)}
          </ul>
        </section>
      )}
      {issue.planPath === undefined ? null : <CaseSection label={t('pool.case.plan')} body={issue.planPath} />}
    </React.Fragment>
  )
}

/** A section inside the case: only the sections the record truly carries take the page. */
function CaseSection(props: { readonly label: string; readonly body: React.ReactNode }): React.ReactElement {
  return (
    <section className="pf-case-sec">
      <h3 className="pf-case-label">{props.label}</h3>
      <p className="pf-case-body">{props.body}</p>
    </section>
  )
}

/** The two marks inside the record's own prose: `**emphasis**` and `` `code` ``; every other character is untouched. */
function prose(said: string): React.ReactNode {
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/gu
  const out: React.ReactNode[] = []
  let at = 0
  let found = pattern.exec(said)
  while (found !== null) {
    if (found.index > at) out.push(...proseLines(said.slice(at, found.index)))
    out.push(found[1] === undefined
      ? <code className="pf-inline-code" key={`c${String(at)}`}>{found[2]}</code>
      : <strong key={`s${String(at)}`}>{found[1]}</strong>)
    at = found.index + found[0].length
    found = pattern.exec(said)
  }
  if (at < said.length) out.push(...proseLines(said.slice(at)))
  return out
}

/** Newlines in a sentence draw as line breaks: as many lines in the record's field, as many here. */
function proseLines(said: string): React.ReactNode[] {
  return said.split('\n').flatMap((line, at) => (at === 0 ? [line] : [<br key={`n${String(at)}`} />, line]))
}