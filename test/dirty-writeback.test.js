import { test } from "node:test";
import assert from "node:assert/strict";

import { Gate, ResourceBlockedError } from "../src/index.js";
import { createPlan } from "../src/planner.js";
import { ResizeExecutor } from "../src/executor.js";

const input = {
  currentMb: 256,
  targetMb: 128,
  activeConnections: 4,
  pageCacheMb: 128,
  lockTableMb: 32,
  checkpointActive: false,
  dirtyPages: 30,
  swappedPages: 2,
  memoryPressureMb: 0,
};

test("刷盘前外部回写请求在非屏障阶段可正常完成", () => {
  const executor = new ResizeExecutor(createPlan(input));
  const result = executor.requestFlush(0);
  assert.equal(result.flushed, true);
  assert.equal(executor.env.pageTable.get(0).dirty, false);
  assert.equal(executor.env.flushCount, 1);
});

test("刷盘阶段进入映射屏障后，外部刷盘与访问均被拒绝", () => {
  const executor = new ResizeExecutor(createPlan(input));
  const flush = executor.plan.phases.find((item) => item.name === "FLUSH_DIRTY_PAGES");
  executor.executePhase(flush);
  assert.equal(executor.isBlocked(Gate.MAPPING_BARRIER), true);
  assert.throws(() => executor.accessPage(0), ResourceBlockedError);
  assert.throws(() => executor.requestFlush(1), ResourceBlockedError);
});

test("脏页全部刷盘后才允许驱逐富余页，事件顺序正确", () => {
  const executor = new ResizeExecutor(createPlan(input));
  const outcome = executor.run();
  assert.equal(outcome.ok, true);
  const types = executor.env.events.map((event) => event.type);
  assert.ok(types.indexOf("dirty_pages_flushed") < types.indexOf("surplus_evicted"));
  const flushEvent = executor.env.events.find((event) => event.type === "dirty_pages_flushed");
  assert.equal(flushEvent.count, 30);
  const dirtyLeft = [...executor.env.pageTable.values()].filter(
    (page) => page.dirty && !page.evicted,
  );
  assert.equal(dirtyLeft.length, 0);
});

test("刷盘阶段故障：脏页状态回滚，尺寸保持 256MB 一致", () => {
  const executor = new ResizeExecutor(createPlan(input), {
    failAt: "FLUSH_DIRTY_PAGES",
  });
  const outcome = executor.run();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rollbackSizeMb, 256);
  const dirty = [...executor.env.pageTable.values()].filter((page) => page.dirty);
  assert.equal(dirty.length, 30);
  assert.equal(executor.env.flushCount, 0);
  assert.deepEqual(executor.env.blocked, []);
});

test("非脏页的刷盘请求是幂等空操作", () => {
  const executor = new ResizeExecutor(createPlan({ ...input, dirtyPages: 0 }));
  const result = executor.requestFlush(0);
  assert.equal(result.flushed, false);
});
