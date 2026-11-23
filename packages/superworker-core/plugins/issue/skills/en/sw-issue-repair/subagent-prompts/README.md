# subagent-prompts — Copies (Originals in `sw-conduct`)

> This directory holds byte-identical **copies** of two `sw-conduct` role cards (`fix.md` and `review.md`), matching `sw-conduct/subagent-prompts/`.

**Why copies exist**: plugins are installed and removed independently by folder. When only `issue` is installed, `sw-conduct` may not exist on disk, yet every Fix / Review batch in `sw-issue-repair` needs these two role cards.

**Maintenance rule**: always edit the **originals** in `sw-conduct/subagent-prompts/` and copy them here verbatim so the two never drift.
