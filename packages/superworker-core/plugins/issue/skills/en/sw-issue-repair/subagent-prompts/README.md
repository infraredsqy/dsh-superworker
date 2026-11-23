# subagent-prompts — copies, the originals are `sw-conduct`'s

> What sits in this folder are **copies** of `sw-conduct` role cards: `fix.md`, `review.md` and
> `execute.md`, byte for byte the same files as the ones in the `sw-conduct` skill's own
> `subagent-prompts/`. The sibling `../subagent-anti-patterns/` comes the same way: copies of the two
> cards in `sw-conduct`'s folder of the same name.

Why copies: a plugin is installed and removed by folder. With only `issue` installed, the `sw-conduct`
directory may not be on this machine at all, and every batch of Fix / Review in `sw-issue-repair`
reads these cards — a pointer into nothing leaves the reader to invent one.

Which one to edit: **the original** (in `sw-conduct`'s `subagent-prompts/` and `subagent-anti-patterns/`),
then copy it here. Editing only this folder is how two roads come to state two different rules.
