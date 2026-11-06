# subagent-prompts — copies, the originals are `pf-conduct`'s

> What sits in this folder are **copies** of two `pf-conduct` role cards: `fix.md` and `review.md`,
> byte for byte the same files as the ones in the `pf-conduct` skill's own `subagent-prompts/`
> (`tests/plugin-issue-skill-cards.test.ts` compares them; an edit on either side turns it red).

Why copies: a plugin is installed and removed by folder. With only `issue` installed, the `pf-conduct`
directory may not be on this machine at all, and every batch of Fix / Review in `pf-issue-repair`
reads these two cards — a pointer into nothing leaves the reader to invent one.

Which one to edit: **the original** (in `pf-conduct`'s `subagent-prompts/`), then copy it here. Editing
only this folder is how two roads come to state two different rules.
