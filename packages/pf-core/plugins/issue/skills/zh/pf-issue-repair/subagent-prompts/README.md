# subagent-prompts — 副本，正本在 `pf-conduct`

> 这个文件夹里是 `pf-conduct` 角色卡的两份**副本**：`fix.md` 与 `review.md`，与
> `pf-conduct` 技能目录下 `subagent-prompts/` 里的同名文件一字不差（`tests/plugin-issue-skill-cards.test.ts`
> 按字节对拍，改了任一处就红）。

为什么带副本：插件按文件夹各自装、各自卸。只装了 `issue` 时，`pf-conduct` 的目录可能根本不在本机，
而 `pf-issue-repair` 的每一批 Fix / Review 都要读这两份卡——指路指到空处，读的人只好自己编一份。

改哪一份：**改正本**（`pf-conduct` 的 `subagent-prompts/`），然后把同一份拷到这里；只改这里等于
让两条路说出两套规矩。
