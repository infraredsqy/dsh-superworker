# Communicating with the user

> This document defines one thing: how an agent communicates when handing information to a human user. Milestone updates, close-out summaries, blocking decisions, requirement alignment, and surfacing technical debt all follow these rules.
> Internal session artifacts (subagent reports, prompts, `run.md`, handoff tickets) follow their own formats — those documents are meant to retain exact code coordinates and measurements.

## 1. Synthesize before presenting

**The agent synthesizes; the user decides.** Facts scattered across a codebase only become actionable once combined into a single coherent issue. That synthesis is the agent's job — do not hand raw search findings to the user to assemble.

| | Synthesized issue (right) | Raw sightings (wrong) |
|---|---|---|
| What is stated | The same state is split across two writers with no ordering guarantee, so readers can observe a half-written record | This logic appears in A and in B; A does X, B does Y; they are connected through a bridge |
| User's first step | Evaluate and decide | Mentally reconstruct both sides before judging |

Listing raw findings looks detailed, but it leaves the analysis undone. If an issue cannot be stated in one clear sentence, finish synthesizing before bringing it to the user.

## 2. Four required parts per issue

Present one issue at a time, and include all four parts:

| Part | Content |
|---|---|
| **Problem** | One sentence stating what is wrong |
| **Impact if left unaddressed** | Under what conditions it fails, how it manifests, and how long it could go unnoticed |
| **Options** | Viable approaches and their trade-offs (scope of change, residual risk or debt) |
| **Recommendation** | Which option to take, and why |

**Two hard constraints:**

- **No code coordinates**: omit file paths, line numbers, raw identifier spellings, and call chains from user-facing explanations.
- **Concrete failure scenario**: the user must be able to picture *when* and *how* it breaks. Vague statements (such as "these two modules are somewhat coupled and should be cleaned up") convey nothing and must be rewritten.

## 3. Terminology level (`config get answer`)

Read the user's preference via `config get answer`. Two values are supported:

| Value | How terms are presented |
|---|---|
| `technical` | Use the precise technical term directly (e.g., "Should this switch to an event-driven model?") |
| `plain` (default) | Use the same term followed by a one-sentence explanation (e.g., "the producer notifies listeners on change, rather than polling on an interval") |

**Both levels carry the same substance**: all four parts remain intact, and neither level includes code coordinates. `technical` omits only the inline explanation sentence, never the analysis itself.

This setting applies only when addressing a human user and is ignored in fully automated runs. If the user indicates they already know a term, respond in `technical` for that turn; if this recurs, persist it with `config set answer technical --global`.

## 4. When to ask

Before interrupting the user, check where the answer lives:

| Answer source | Typical questions | Action |
|---|---|---|
| User only | UX preference, whether an effort is worthwhile, priority order, acceptable trade-offs | Ask once, clearly, with options and trade-offs |
| Agent's scope | Internal naming, file layout, internal step ordering | Decide autonomously and record it in the current execution log (e.g., the autonomous decisions list in `run.md`) |
| Unverified facts | Metrics requiring measurement, behavior requiring code inspection | Inspect directly or dispatch a subagent |

**Stopping to wait for the user requires both conditions**: only the user can answer, and work cannot safely proceed without it. If either condition is missing, do not block.

## 5. Milestone and close-out reports

When reporting results to the user, cover three items in order:

1. **Delivered**: one sentence summarizing what was completed.
2. **Open issues**: any remaining unresolved issues (explicitly state "none" if clear).
3. **Decision needed**: the specific call the user can make now (or what is still missing before a decision is possible).

Always distill subagent technical reports into these three items before presenting them — never forward raw subagent output verbatim.
