# dsh-superworker — Design Principles

> This document states this repository's **law** — high-level design, architectural, and visual
> constraints to read before changing the UI. It holds principles, not current implementation state
> or concrete token values (those live in code and stylesheets; tuning a value is a design decision
> that does not violate these rules).
>
> **Adding any rule requires explicit user approval. Hard cap: 100 lines — make room before adding.**
> Explain *what changed and why* in commit messages; keep unfinished exploration in gitignored `.tmp/`.

## Purpose

This repository renders a workspace's `.superworker/` pipeline record as a live work panel inside DSH.

**The panel is a face of the record, not a second source of truth.** Every datum displayed comes from
real record data, and layout emerges from that data. A bare number without a unit tells the reader
nothing — omit it rather than print it.

## The Two Cardinal Rules

- **Never narrate the UI.** Controls express their own state; readings carry their own units. Never
  write helper copy like "This view shows…". When a control needs an explanation, clarify the control
  itself rather than adding caption text beside it.
- **Never draw what isn't there.** Do not print missing readings. An empty section gets no orphan
  heading, no "None yet" placeholder, and no padded empty box.

## 1. Domain & Responsibility Boundaries

- **One vocabulary, owned by the record.** The `.superworker/` record schema is the sole source of
  domain semantics. This repo consumes that vocabulary rather than redefining it or inventing parallel
  readings across layers.
- **Derived states are pure projections.** Operational states such as active execution, readiness, or
  waiting on a human gate are computed purely from persisted record facts at read time. The panel
  never introduces or stores synthetic status flags of its own.
- **Never fabricate missing metrics.** If the engine does not track a quantity (such as remaining
  steps on a pipeline line), the panel does not estimate or display it.
- **Facts belong to the model; phrasing belongs to the client.** The model layer computes structured
  domain facts (states, counts, gate reasons) and never formats user-facing copy. The client layer
  owns all phrasing through locale tables with identical, compile-checked key sets — adding a language
  means adding one table, never touching model logic.

## 2. Visual Ground & Restraint

- **Use DSH's design tokens exclusively.** Never invent standalone colors or ad-hoc font sizes. Keep
  the semantic color budget strictly bounded (reusing a small fixed palette across semantic roles) —
  to introduce a new semantic hue, retire an existing one first.
- **Share visual primitives across views.** When two views express the same concept, they must render
  through the same shared token and primitive rather than duplicating style values per view.
- **Typography follows role.** Use DSH's display role only for top-level landmarks, system sans for
  body text, and monospace with `tabular-nums` for all numeric readings so values align cleanly.
- **Built for glanceability between tasks.** Timestamps remain static (never live-ticking), the page
  body never scrolls, and viewport-relative units (`vh` / `vw`) are forbidden — headless capture
  resizes the viewport before taking screenshots, causing mid-shot reflow.
- **Contrast follows reading mode.** Marks that must be distinguished individually must meet strict
  legibility contrast in every theme; dense scales read collectively as texture or density may sit
  quieter. Concrete thresholds live in the style checker and tokens, not here.

## 3. Copy & Information Discipline

- **Never say the same thing twice.** Information already communicated by column, grouping, or layout
  is not repeated inside every card.
- **Keep machine telemetry out of the reading flow.** Internal scores, grades, or raw progress metrics
  do not belong in primary prose; demote them to compact chips or hover details if kept at all.
- **Never expose raw session IDs.** Opaque identifiers carry no meaning to a human reader.
- **Show prerequisite status only for unstarted work.** Finished work owes nothing, and active work
  has already cleared its gate.
- **Human gates appear only when action is needed, and always sort first.** Items waiting on a person
  rise ahead of routine active work so the reader encounters them first; when none exist, the group
  vanishes completely.

## 4. Views, Layout & Motion

- **One organizing axis and one signature element per view.** Each view answers a single question and
  is identified by one signature artifact; shared chrome (landmarks, workspace context, reading rows)
  looks identical across every view.
- **Collapsing never shifts layout.** Folding hides content in place while surrounding geometry stays
  anchored.
- **Only three legal motion origins:** emerging from the exact element that triggered it, scaling in
  place from its own center on view entry, or folding back into its header on collapse. No fourth
  origin is permitted — and never animate from an unmeasured geometry (if geometry is not measured
  yet, render nothing).
- **Mirror DSH controls before inventing.** Common controls (resize handles, tabs, inline actions,
  dropdowns) match DSH's own sizing, weight, and spacing verbatim. Build custom controls only when
  DSH provides none.

## 5. Code, Comments & Documentation

- **One-way documentation pointers.** Code and comments never cite markdown paths, section numbers, or
  line numbers; documentation may point to code, never the reverse.
- **Comments explain *why*, never *what*.** Keep a comment only when reading the adjacent code cannot
  explain why it is shaped that way. Architectural overviews belong in directory signposts
  (`AGENTS.md`), not file headers.
- **Never commit volatile readings to prose.** Counts, byte sizes, hashes, timings, and PIDs rot
  immediately — run a command when you need a measurement.
- **Signposts (`AGENTS.md`) stay brief and scoped.** One line per child directory or standalone file,
  one idea per line ("what it holds + when to read it"), capped at 15 lines. Deeper concerns belong in
  deeper signposts; file and function inventories belong in code.
