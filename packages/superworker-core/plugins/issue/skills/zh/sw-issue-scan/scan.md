# Scan 角色卡

> 角色：执行者（由指挥者派发）。只扫描分配给你的文件，**不得再向下派发任何 subagent**。

## 职责

扫描指定模块的代码，按指定维度找出质量债，写入结构化 JSON 供指挥者合并；同时核对下发的已有条目是否仍然存在。

## 执行流程

1. 通读分配的全部文件，理解调用方与被调用方上下文
2. 按指定维度分析：重复代码 / 职责越界 / 结构问题
3. 为每条发现生成结构化字段与唯一 ID
4. 一次性写入 `.superworker/meta/scan/<module-slug>.json`
5. 按三层定位规则核对已有条目清单
6. 返回结构化摘要

## ID 规则

`<module-slug>-<short-slug>`，kebab-case（小写字母 + 连字符），长度 ≤64 字符。

- 正确：`export-job-close-no-event`、`ui-direct-cache-writes`
- 错误：`export_job_close`（含下划线）、`issue 1`（含空格）、`fix-grid`（未说明问题）

## 输出文件格式

输出至 `.superworker/meta/scan/<module-slug>.json`（如 `export.json`、`ui.json`），为 JSON 数组。每条必须包含：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一 ID |
| `severity` | string | `P0` / `P1` / `P2` / `P3`（口径见 [`../sw-issue-repair/pool.md`](../sw-issue-repair/pool.md)） |
| `module` | string | 模块名（如 `core/export`、`export`、`ui`） |
| `title` | string | 简短标题（≤30 字） |
| `description` | string | 一句话说清问题 |
| `suggestion` | string | 一句话说清修法 |
| `files` | string[] | 涉及的文件（相对路径） |
| `functions` | string[] | 涉及的函数名 |

**不含 `decision` 字段**：`autofix` / `external` 的裁定不归扫描阶段，新条目入池默认为 `unknown`。

示例：

```json
[
  {
    "id": "export-job-close-no-event",
    "severity": "P0",
    "module": "export",
    "title": "export_job_close 缺少 JobClosed 事件",
    "description": "export_job_close 不发送 JobClosed 事件也不清理缓存引用，但 export_image_close 两者都做。",
    "suggestion": "引入统一的内部 close-job 辅助函数供两个桥接函数调用。",
    "files": ["src/export/bridge_image.cpp", "src/export/bridge_csv.cpp"],
    "functions": ["export_job_close", "export_image_close"]
  }
]
```

## 返回摘要

在返回消息末尾附以下结构化摘要供指挥者汇总：

```
SCAN_RESULT:
  wrote: 8
  alive_ids: ["existing-id-1", "existing-id-2"]
  scan_file: ".superworker/meta/scan/export.json"
```

- `wrote`：本次写入的条目数
- `alive_ids`：确认仍然存在的已有条目 ID（无法确认的不列入）

## 规则

- **先读完全部文件再一次性写 JSON**，不要逐条写入
- **按三层定位**：函数名/类名 → 语义描述 → 文件路径，不依赖易变的行号；核对已有条目同样按这三层，三层均找不到时才不列入 `alive_ids`
- **不确定修法也照实写**：在 `suggestion` 中写清缺少哪项背景或哪个设计尚未定案，不要以「不确定」为由推给用户
- **只报实际读过的文件**：未打开过的文件不写入 `files`

## 反模式

开始前对照 [`./anti-patterns.md`](./anti-patterns.md) 自查。
