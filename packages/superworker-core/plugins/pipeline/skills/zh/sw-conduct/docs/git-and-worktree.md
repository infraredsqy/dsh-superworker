# Git 同步、双档提交与 Worktree 手册

> 何时读本文件：准备第 0 步遇到本地档/冲突、准备第 4 步需要创建 worktree、或收尾第 3/7 步需要合回与提交记录时。

## 一、`.superworker/` 双档同步与冲突处理

通过 `git ls-files .superworker` 判定档位（有输出 = **提交档**，无输出 = **本地档**；以磁盘状态为准，不要手工挪动）：
- 本地档记录仅存于本机（换机、重克隆、`git clean -xdf` 会丢失），除非 `.superworker/` 自身初始化为独立 git 仓库（存在 `.superworker/.git`）。

### 准备第 0 步：拉取同步

**两条命令都必须在项目根执行**（fork 模式下切勿在 worktree 目录内执行 `git -C .superworker`）：
- **提交档**：`git pull --rebase`
- **本地档**：先 `git pull --rebase` 拉代码；若存在 `.superworker/.git` 且有远端，再 `git -C .superworker pull --rebase` 拉记录。
- 无 `git remote` 的仓库直接跳过 pull 与 push。

### 冲突处理

- `.superworker/` 下的记录 JSON 由自定义合并驱动处理（图、cycle、指令、交接单按领域规则合并；其他带集合键且项含 `id` 的 JSON 如 `.superworker/issues/issues.json` 按条目求并）。
- `config.json` 显式退出合并驱动，两侧均改时按冲突保留本侧交用户裁定。
- **遇到合并驱动报错或代码冲突**：严禁自行乱合。若卡在 rebase 中途，先 `git rebase --abort`（记录仓库则 `git -C .superworker rebase --abort`）还原现场，再上报用户。
- 若被本地未提交改动阻塞（多为上个会话提交未落地），重试一次；仍失败则停手问用户。

### 收尾第 7 步：提交关节点记录

节点代码与文档已在第 3 步收成主树的一次 `feat:` 提交；第 7 步只收关节点命令写入的图、cycle 与交接单（整盘一份，并行节点可能已顺手提交）：

- **提交档**：
  ```pwsh
  git status                      # 应仅剩图、cycle 与交接单
  git diff
  git commit -m "chore: record node <节点id> close (slip, cycle state)"
  git push
  ```
- **本地档（有 `.superworker/.git`）**：连同本节点的 `run.md` 与报告集一起提交到记录仓库：
  ```pwsh
  git -C .superworker status
  git -C .superworker add -A
  git -C .superworker commit -m "chore: record node <节点id> close (slip, cycle state)"
  git -C .superworker push        # 有远端才推
  ```
- **本地档（无 `.superworker/.git`）**：跳过此步，记录留在本地磁盘。

`git push` 被拒时先 `git pull --rebase` 再推；冲突交用户。若推送卡死，停手告知用户：修好推送后执行 `advance --cycle <cycle>` 即可（节点已 `settle`，无需重收）。

---

## 二、`worktree_mode` 与 Fork / 合回规程

`config get worktree_mode` 三档行为（修改用 `config set worktree_mode <值>`）：

| 档位 | 行为 |
|---|---|
| `off` | 主树直做，无 fork 与合回。无隔离，多线并行或 `parallel > 1` 时勿用 |
| `fork`（默认） | 每节点独立新 worktree，收尾 squash 合回后删除 |
| `reuse` | 工具暂未支持：读到此档停手交用户改档，**严禁手工 `git worktree add` 凑数** |

以下规程适用于 **`fork` 档**。

### 1. Fork（准备第 4 步）

先做三道检查（**严禁跳过**），全部通过再建 worktree 与分支：

```pwsh
# 1. 检查主树已跟踪文件是否干净（未跟踪文件不算）
git status --porcelain --untracked-files=no
# 2. 检查检出目录是否被占
Test-Path .superworker/worktrees/<节点短id>
# 3. 检查分支名是否被占
git rev-parse --verify --quiet refs/heads/sw/<节点短id>
# 4. 全部通过后创建
git worktree add .superworker/worktrees/<节点短id> -b sw/<节点短id>
```

- **检查 1 有输出（主树不干净）**：停手，原样输出以下提示，等几分钟复查 `git status` 再试：
  > the main tree has uncommitted tracked changes -- another line may be mid-merge-back (the docs sync and the ledger commit leave a dirty window of minutes). Wait a few minutes and re-check `git status` before forking:
- **检查 2 或 3 被占用**：什么都不建，停手交用户，按对应情况原样输出：
  > .superworker/worktrees/<节点短id> already exists -- the short id '<节点短id>' is taken (by node <节点id> itself, or the last fork was never cleaned up). Nothing was forked.
  >
  > branch sw/<节点短id> already exists -- the short id '<节点短id>' is taken. Nothing was forked.

记下 fork 时主树所在分支（`git rev-parse --abbrev-ref HEAD`）作为**出口分支**写入 `run.md` 的「已核事实」。

### 2. Worktree 内干活与路径约定

- Execute / Review / Fix / Doc-sync 的代码与文档路径一律指向 worktree 绝对路径（`light` 节点同样在 worktree 内操作、跑快档）。
- **`run.md` 与报告集位置**：提交档写在 worktree 的 `.superworker/nodes/<uuid>/`（随节点合回）；本地档写在**主树**的 `.superworker/nodes/<uuid>/`（worktree 中不含被忽略的 `.superworker/`）。
- **`temp/`（探针与原始输出）**：两种档一律写**主树**的 `.superworker/nodes/<uuid>/temp/`。
- 管线命令在 worktree 内直接执行即可，工具自动识别主树并写入记录。
- 节点内部的多个并行 subagent 共用同一个 worktree，收尾只合回一次。
- 多线在主树执行 git 写操作遇到 `index.lock` 时，等几秒重试，2~3 次仍失败交用户；**严禁手工删除锁文件**。

### 3. 合回与清理（收尾第 3~4 步）

前提：Doc-sync 与 `run.md` 均已落盘。**以下命令全部在主树根目录执行**：

1. **在 worktree 内提交并合入主树最新进展**：
   ```pwsh
   git -C .superworker/worktrees/<节点短id> add -A
   git -C .superworker/worktrees/<节点短id> commit -m "feat: <这个节点做了什么>"
   git -C .superworker/worktrees/<节点短id> merge <出口分支>
   ```
   有冲突在 worktree 内解决并重跑快档。
2. **在主树 squash 合回成单次提交**：
   ```pwsh
   git merge --squash sw/<节点短id>
   git commit -m "feat: <同上>"
   ```
   若主树不在出口分支上、或 squash 仍冲突（期间他线合入了新提交），停手交用户。
3. **主树跑全量并清理**：
   - 全量验证在主树上跑；报数前确认 `git log` 未新增他线提交，若有则重跑全量。
   - 全量通过后立刻清理 worktree 与分支，再继续第 5 步自查：
     ```pwsh
     git worktree remove .superworker/worktrees/<节点短id>
     git branch -D sw/<节点短id>
     ```
