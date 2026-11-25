import { test } from "node:test";
import assert from "node:assert/strict";

import { Direction, Gate, ResizeValidationError } from "../src/index.js";
import { createPlan, verifyPlan } from "../src/planner.js";

const baseInput = {
  currentMb: 512,
  targetMb: 1024,
  activeConnections: 8,
  pageCacheMb: 256,
  lockTableMb: 64,
  checkpointActive: true,
  dirtyPages: 40,
  swappedPages: 8,
  memoryPressureMb: 2048,
};

test("扩容计划包含完整阶段顺序与正确方向", () => {
  const plan = createPlan(baseInput);
  assert.equal(plan.direction, Direction.GROW);
  assert.deepEqual(
    plan.phases.map((item) => item.name),
    [
      "VALIDATE_REQUEST",
      "ALLOCATE_TARGET_REGION",
      "QUIESCE_CHECKPOINT",
      "DRAIN_CONNECTIONS",
      "MIGRATE_LOCK_TABLE",
      "MIGRATE_PAGE_CACHE",
      "REMAP_CONNECTIONS",
      "MAPPING_BARRIER",
      "COMMIT_NEW_REGION",
      "RELEASE_OLD_REGION",
      "RESUME_WORKLOAD",
    ],
  );
  assert.equal(verifyPlan(plan).ok, true);
});

test("锁表迁移必须先于旧区域释放，且释放阶段阻塞锁表", () => {
  const plan = createPlan({ ...baseInput, targetMb: 256 });
  const lockIndex = plan.phases.findIndex((item) => item.name === "MIGRATE_LOCK_TABLE");
  const releaseIndex = plan.phases.findIndex((item) => item.name === "RELEASE_OLD_REGION");
  const commitIndex = plan.phases.findIndex((item) => item.name === "COMMIT_NEW_REGION");
  assert.ok(lockIndex < commitIndex);
  assert.ok(commitIndex < releaseIndex);
  const release = plan.phases[releaseIndex];
  assert.ok(release.blocks.includes(Gate.LOCK_TABLE));
  assert.equal(release.rollbackPoint.sizeMb, 256);
});

test("脏页刷盘与换入阶段持有映射屏障，页访问无法并发", () => {
  const plan = createPlan({ ...baseInput, targetMb: 256 });
  for (const name of ["PAGE_IN_SWAPPED", "FLUSH_DIRTY_PAGES", "EVICT_SURPLUS_PAGES"]) {
    const item = plan.phases.find((phase) => phase.name === name);
    assert.equal(item.exclusive, true, `${name} 必须互斥`);
    assert.ok(item.blocks.includes(Gate.MAPPING_BARRIER));
    assert.ok(item.blocks.includes(Gate.PAGE_CACHE));
  }
});

test("缩容阶段先处理换出页和脏页，再驱逐富余页并迁移", () => {
  const plan = createPlan({ ...baseInput, targetMb: 256 });
  const names = plan.phases.map((item) => item.name);
  assert.ok(names.indexOf("MARK_SURPLUS_PAGES") < names.indexOf("PAGE_IN_SWAPPED"));
  assert.ok(names.indexOf("PAGE_IN_SWAPPED") < names.indexOf("FLUSH_DIRTY_PAGES"));
  assert.ok(names.indexOf("FLUSH_DIRTY_PAGES") < names.indexOf("EVICT_SURPLUS_PAGES"));
  assert.ok(names.indexOf("EVICT_SURPLUS_PAGES") < names.indexOf("MIGRATE_LOCK_TABLE"));
  const evict = plan.phases.find((item) => item.name === "EVICT_SURPLUS_PAGES");
  assert.equal(evict.migration.pages, (512 - 256) / 4);
});

test("每个阶段都带一致尺寸回滚点", () => {
  const grow = createPlan(baseInput);
  const shrink = createPlan({ ...baseInput, targetMb: 256 });
  for (const item of [...grow.phases, ...shrink.phases]) {
    assert.ok(Number.isInteger(item.rollbackPoint.sizeMb));
    assert.ok(item.rollbackPoint.sizeMb > 0);
  }
  const commit = grow.phases.find((item) => item.name === "COMMIT_NEW_REGION");
  assert.equal(commit.rollbackPoint.sizeMb, 1024);
});

test("内存余量不足时标记预期校验故障，目标过小同理", () => {
  const grow = createPlan({ ...baseInput, memoryPressureMb: 100 });
  assert.deepEqual(grow.expectedValidationFault, {
    phase: "VALIDATE_REQUEST",
    message: "内存余量 100MB 小于扩容增量 512MB",
  });
  const shrink = createPlan({ ...baseInput, targetMb: 32, lockTableMb: 64 });
  assert.match(shrink.expectedValidationFault.message, /无法容纳锁表/);
});

test("非法输入直接抛出校验错误", () => {
  assert.throws(() => createPlan({ ...baseInput, targetMb: 512 }), ResizeValidationError);
  assert.throws(() => createPlan({ ...baseInput, pageCacheMb: 9999 }), ResizeValidationError);
});
