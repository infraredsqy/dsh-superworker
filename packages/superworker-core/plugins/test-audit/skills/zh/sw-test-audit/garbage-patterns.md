# 垃圾测试模式

> 供 scan subagent 使用，与 [`./compression-criteria.md`](./compression-criteria.md) 一同读取；指挥者不读本文件。

## 垃圾模式清单

| # | 模式 | 语言无关描述 | 典型示例（Catch2 / Jest / pytest） |
|---|---|---|---|
| P1 | `hardcoded-count` | 断言集合、方法或条目的固定数量 | `REQUIRE(result.size() == 36)`、`expect(methods.length).toBe(10)` |
| P2 | `trivial-init` | 仅验证语言/框架保证的默认初始值 | `REQUIRE(field == false)`、`assert(field is None)`、`expect(obj.count).toBe(0)` |
| P3 | `field-roundtrip` | 赋值后立即回读验证 | `x = val; REQUIRE(x == val)`、`obj.name = "foo"; assert obj.name == "foo"` |
| P4 | `enum-bound` | 将枚举或常量绑定到具体整数值 | `REQUIRE(static_cast<int>(Enum::A) == 0)`、`assert(Color.RED == 1)` |
| P5 | `container-op` | 测试标准容器的基本增删查操作 | `map.erase(k); REQUIRE(map.size() == 0)`、`arr.append(x); assert len(arr) == 1` |
| P6 | `trivial-error` | 仅验证错误入参返回固定错误码 | `REQUIRE(func(bad) == -1)`、`assert(parse("").is_err())` |

## 判定粒度

- 整个 `TEST_CASE`（或同类测试容器）的所有断言均命中垃圾模式 → 整段删除（`judgment: "entire"`）
- 部分断言命中垃圾模式、部分验证真实业务逻辑 → 仅删垃圾断言行，保留有效部分（`judgment: "partial"`）
- 文件内所有测试均被清空 → 同时从构建系统（`CMakeLists.txt` / `Cargo.toml` / `package.json` 等）中移除该文件

## 删除覆盖门槛

命中垃圾模式只满足一半条件，**删除前必须确认其验证的业务在别处已有覆盖**：

- 命中垃圾模式 **且** 别处已有覆盖 → 可删除
- 命中垃圾模式，但它是该业务的**唯一**覆盖 → 保留并在报告中说明
- 无法确认别处是否有覆盖 → 在报告中点出该业务交由指挥者核查，**宁可保留**

核查覆盖必须实际搜索（同文件相邻用例、同类模块测试、端到端用例的间接覆盖），不得凭印象判断。

## 安全例外

以下情形**不属于**垃圾测试，禁止误删：

- 验证字段被显式初始化为非零/非空值（业务要求且异于语言默认值）
- 验证边界条件行为（如空集合查询不崩溃、负数索引被 clamp）
- 验证序列化 roundtrip（写入后再反序列化核对字段一致）
- 验证状态机转换合法性

## 返回字段（`quality` 对象）

与 [`./compression-criteria.md`](./compression-criteria.md) 合并为同一份 JSON 返回，每条 finding 的 `quality` 字段格式如下（完整合并格式见 `compression-criteria.md`）：

```json
"quality": {
  "type": "enum-bound",
  "line_start": 15,
  "line_end": 22,
  "judgment": "entire"
}
```

- `judgment`：`entire`（整段均为垃圾断言）/ `partial`（混合用例，仅删垃圾行）/ `none`（验证真实业务）
