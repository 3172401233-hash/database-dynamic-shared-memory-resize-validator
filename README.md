# database-dynamic-shared-memory-resize-validator

数据库共享内存**动态扩缩容的阶段规划与回滚验证器**。

> ⚠️ **本项目不操作任何真实数据库。** 所有区域、连接、锁表、页缓存、checkpoint、
> 脏页和换出页都只是 Node.js 进程内的普通对象与 Map，不调用 `mmap`/`shm_*`、
> 不连接数据库、不读写磁盘数据文件、不创建任何操作系统共享内存段。它是一个用于
> 验证 resize 编排顺序、阻塞关系、页迁移规则与故障回滚点的**纯逻辑模拟器**。

运行环境：Node.js `24.16.0`（使用内置 `node:test`，零第三方依赖）。

## 要验证的问题

在线扩大共享内存时，连接、锁表和页缓存可能仍引用旧区域；缩容时可能存在未完成的
checkpoint，部分页面被换出后又被访问。模拟器强制保证：

- 锁表迁移完成、连接重定向完成之前，**旧区域不能释放**；
- 脏页刷盘与页访问在**映射屏障内互斥**，不会并发破坏映射；
- 任一阶段失败都基于阶段前快照回滚到**一致尺寸**，并恢复锁表/连接归属与门控。

## 输入参数

`createPlan(input)` 或 CLI 接收以下参数（单位 MB，页数按每页 4MB 折算）：

| 字段 | 含义 |
| --- | --- |
| `currentMb` | 当前共享内存区域大小 |
| `targetMb` | 目标大小（大于当前为扩容，小于当前为缩容） |
| `activeConnections` | 活跃连接数（DRAIN 阶段阻塞） |
| `pageCacheMb` | 页缓存占用大小 |
| `lockTableMb` | 锁表占用大小 |
| `checkpointActive` | 是否存在未完成 checkpoint |
| `dirtyPages` | 脏页数量（缩容时先刷盘再驱逐） |
| `swappedPages` | 被换出后可能再被访问的页面数 |
| `memoryPressureMb` | 可用内存余量；扩容增量超过它时 VALIDATE 失败 |

## 输出：阶段顺序、阻塞资源、页迁移与回滚点

每个阶段对象包含：

- `name` / `label`：阶段标识与说明；
- `blocks`：进入阶段后阻塞的资源门（`connections`、`lock_table`、`page_cache`、
  `checkpoint`、`mapping_barrier`）；
- `exclusive`：是否持有映射屏障（页访问/刷盘在此期间被拒绝）；
- `migration`：页迁移动作（分配区域、锁表迁移、页缓存迁移、换入、刷盘、驱逐、
  连接重定向、提交、释放旧区域）；
- `rollbackPoint`：该阶段失败时回到的一致尺寸。

### 扩容阶段（11 个）

`VALIDATE_REQUEST → ALLOCATE_TARGET_REGION → QUIESCE_CHECKPOINT → DRAIN_CONNECTIONS
→ MIGRATE_LOCK_TABLE → MIGRATE_PAGE_CACHE(互斥) → REMAP_CONNECTIONS → MAPPING_BARRIER(互斥)
→ COMMIT_NEW_REGION → RELEASE_OLD_REGION → RESUME_WORKLOAD`

### 缩容阶段（14 个）

`VALIDATE_REQUEST → QUIESCE_CHECKPOINT → MARK_SURPLUS_PAGES → PAGE_IN_SWAPPED(互斥)
→ FLUSH_DIRTY_PAGES(互斥) → EVICT_SURPLUS_PAGES(互斥) → DRAIN_CONNECTIONS
→ MIGRATE_LOCK_TABLE → MIGRATE_PAGE_CACHE(互斥) → REMAP_CONNECTIONS → MAPPING_BARRIER(互斥)
→ COMMIT_NEW_REGION → RELEASE_OLD_REGION → RESUME_WORKLOAD`

计划生成时 `verifyPlan()` 会静态校验：首阶段是 VALIDATE、末阶段是 RESUME、
锁表迁移与提交均早于旧区域释放、提交前经过映射屏障、互斥阶段必持屏障、
每阶段都有有效回滚点。

## 运行方式

```bash
# 文本报告（阶段 / 阻塞 / 迁移 / 回滚点 + 模拟执行结果）
node src/cli.js --current 512 --target 1024 --connections 8 --page-cache 256 \
  --lock-table 64 --checkpoint true --dirty-pages 40 --swapped-pages 8 --pressure 2048

# 只输出 JSON 计划，不执行
node src/cli.js --current 512 --target 256 --connections 10 --page-cache 256 \
  --lock-table 64 --checkpoint true --dirty-pages 30 --swapped-pages 8 --json --plan-only
```

代码内调用：

```js
import { createPlan } from "./src/planner.js";
import { ResizeExecutor } from "./src/executor.js";

const plan = createPlan({
  currentMb: 512, targetMb: 1024, activeConnections: 8, pageCacheMb: 256,
  lockTableMb: 64, checkpointActive: true, dirtyPages: 40,
  swappedPages: 8, memoryPressureMb: 2048,
});

// failAt 可在任意阶段注入故障；executor 自动回滚到该阶段的一致尺寸
const executor = new ResizeExecutor(plan, { failAt: "MIGRATE_PAGE_CACHE" });
const outcome = executor.run(); // { ok:false, phase, rollbackSizeMb, error, env, events }

// 屏障期间调用 accessPage / requestFlush 会抛 ResourceBlockedError
```

## 故障与回滚语义

- 每个阶段执行前拍 `structuredClone` 快照；失败时恢复快照、解除全部门控；
- 提交前失败：回滚点是当前尺寸（旧区域保持 `ACTIVE`，锁表/连接迁回旧区域）；
- 提交后失败：回滚点是目标尺寸（旧区域为 `RELEASE_PENDING`，新区域保持一致）；
- 释放旧区域阶段内置守卫：锁表未迁移、连接未重定向或活跃区域不是新区域时直接拒绝。

## 测试

```bash
node --test
```

共 28 个用例，覆盖：

- **扩容失败**：内存余量不足在 VALIDATE 失败、页缓存迁移中途故障回滚 512MB、
  提交后释放故障回滚目标尺寸、旧区域释放守卫；
- **缩容竞争**：未完成 checkpoint 等待、换出页再访问的缺页换入与屏障阻塞、
  富余页驱逐故障回滚、锁表迁移故障；
- **脏页回写**：非屏障期可刷盘、屏障期访问/刷盘被拒绝、先刷盘后驱逐的事件顺序、
  刷盘故障后脏页状态回滚；
- 计划不变式校验与 CLI 文本/JSON/退出码行为。

## 目录结构

```
src/model.js     # 领域模型、输入归一化、模拟环境与错误类型
src/planner.js   # 扩/缩容阶段规划与计划级不变式校验
src/executor.js  # 门控执行器、页访问/刷盘互斥、快照回滚
src/cli.js       # 命令行入口
test/            # node:test 测试（扩容失败 / 缩容竞争 / 脏页回写 / 计划 / CLI）
```
