import { test } from "node:test";
import assert from "node:assert/strict";

import { Gate, RegionState, ResourceBlockedError } from "../src/index.js";
import { createPlan } from "../src/planner.js";
import { ResizeExecutor } from "../src/executor.js";

const shrinkInput = {
  currentMb: 512,
  targetMb: 256,
  activeConnections: 10,
  pageCacheMb: 256,
  lockTableMb: 64,
  checkpointActive: true,
  dirtyPages: 24,
  swappedPages: 8,
  memoryPressureMb: 0,
};

test("缩容成功：等待 checkpoint、换入页面、驱逐富余页后提交 256MB", () => {
  const executor = new ResizeExecutor(createPlan(shrinkInput));
  const outcome = executor.run();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.committedSizeMb, 256);
  assert.equal(executor.env.checkpoint.active, false);
  assert.ok(executor.env.faultInCount >= 8);
  const evictedPages = [...executor.env.pageTable.values()].filter((page) => page.evicted);
  assert.equal(evictedPages.length, 64);
  assert.equal(executor.env.regions.current.state, RegionState.RELEASED);
  assert.deepEqual(executor.env.blocked, []);
});

test("未完成 checkpoint 会先被等待结束，再进入后续阻塞阶段", () => {
  const executor = new ResizeExecutor(createPlan(shrinkInput));
  const quiesce = executor.plan.phases.find((item) => item.name === "QUIESCE_CHECKPOINT");
  executor.executePhase(quiesce);
  assert.equal(executor.isBlocked(Gate.CHECKPOINT), true);
  assert.equal(executor.env.checkpoint.active, false);
  assert.equal(executor.env.checkpoint.count, 0);
  assert.ok(executor.env.events.some((event) => event.type === "checkpoint_waited"));
});

test("换出后再被访问的页面在屏障内换入，外部访问被阻塞", () => {
  const executor = new ResizeExecutor(createPlan(shrinkInput));
  // 屏障前模拟一个换出页被访问：触发缺页换入。
  const before = executor.accessPage(0);
  assert.equal(before.faulted, true);

  const pageIn = executor.plan.phases.find((item) => item.name === "PAGE_IN_SWAPPED");
  const blocked = executor.executePhase(pageIn);
  assert.equal(blocked.ok, true);
  assert.throws(() => executor.accessPage(1), ResourceBlockedError);
  assert.throws(() => executor.requestFlush(2), ResourceBlockedError);

  const swappedRemaining = [...executor.env.pageTable.values()].filter(
    (page) => page.state === "swapped" && !page.evicted,
  );
  assert.equal(swappedRemaining.length, 0);
});

test("脏页刷盘阶段与页访问互斥，刷盘后无脏页残留", () => {
  const executor = new ResizeExecutor(createPlan(shrinkInput));
  const flush = executor.plan.phases.find((item) => item.name === "FLUSH_DIRTY_PAGES");
  executor.executePhase(flush);
  assert.throws(() => executor.accessPage(0), ResourceBlockedError);
  const dirtyRemaining = [...executor.env.pageTable.values()].filter(
    (page) => page.dirty && !page.evicted,
  );
  assert.equal(dirtyRemaining.length, 0);
});

test("驱逐阶段故障：富余页恢复，回滚到 512MB 一致尺寸", () => {
  const executor = new ResizeExecutor(createPlan(shrinkInput), {
    failAt: "EVICT_SURPLUS_PAGES",
  });
  const outcome = executor.run();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.phase, "EVICT_SURPLUS_PAGES");
  assert.equal(outcome.rollbackSizeMb, 512);
  assert.equal(executor.env.activeRegion, "current");
  const evicted = [...executor.env.pageTable.values()].filter((page) => page.evicted);
  assert.equal(evicted.length, 0);
  assert.deepEqual(executor.env.blocked, []);
});

test("锁表迁移阶段故障：旧区域未释放，锁表仍在旧区域", () => {
  const executor = new ResizeExecutor(createPlan(shrinkInput), {
    failAt: "MIGRATE_LOCK_TABLE",
  });
  const outcome = executor.run();
  assert.equal(outcome.ok, false);
  assert.equal(executor.env.regions.current.state, RegionState.ACTIVE);
  assert.equal(executor.env.lockTable.region, "current");
  assert.equal(executor.env.lockTable.migrated, false);
});
