import { test } from "node:test";
import assert from "node:assert/strict";

import { Gate, RegionState, ResizeFailedError, ResourceBlockedError } from "../src/index.js";
import { createPlan } from "../src/planner.js";
import { ResizeExecutor } from "../src/executor.js";

const baseInput = {
  currentMb: 512,
  targetMb: 1024,
  activeConnections: 6,
  pageCacheMb: 256,
  lockTableMb: 64,
  checkpointActive: true,
  dirtyPages: 20,
  swappedPages: 4,
  memoryPressureMb: 2048,
};

test("扩容成功：提交新区域后旧区域才释放，结束时无阻塞", () => {
  const executor = new ResizeExecutor(createPlan(baseInput));
  const outcome = executor.run();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.committedSizeMb, 1024);
  assert.equal(executor.env.regions.current.state, RegionState.RELEASED);
  assert.equal(executor.env.lockTable.region, "target");
  assert.equal(executor.env.activeRegion, "target");
  assert.deepEqual(executor.env.blocked, []);
  assert.equal(executor.env.checkpoint.active, false);
});

test("内存余量不足：VALIDATE 阶段失败并回滚到原尺寸 512MB", () => {
  const executor = new ResizeExecutor(createPlan({ ...baseInput, memoryPressureMb: 64 }));
  const outcome = executor.run();
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof ResizeFailedError);
  assert.equal(outcome.phase, "VALIDATE_REQUEST");
  assert.equal(outcome.rollbackSizeMb, 512);
  assert.equal(executor.env.activeRegion, "current");
  assert.equal(executor.env.regions.target, null);
  assert.deepEqual(executor.env.blocked, []);
});

test("迁移中途故障：旧区域保持 ACTIVE，连接与锁表回到旧区域", () => {
  const plan = createPlan(baseInput);
  const executor = new ResizeExecutor(plan, {
    failAt: "MIGRATE_PAGE_CACHE",
  });
  const outcome = executor.run();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.phase, "MIGRATE_PAGE_CACHE");
  assert.equal(outcome.rollbackSizeMb, 512);
  assert.equal(executor.env.activeRegion, "current");
  assert.equal(executor.env.regions.current.state, RegionState.ACTIVE);
  assert.equal(executor.env.lockTable.region, "current");
  assert.equal(executor.env.lockTable.migrated, false);
  assert.deepEqual(executor.env.blocked, []);
  assert.ok(executor.env.events.some((event) => event.type === "rollback"));
});

test("提交后释放旧区域故障：回滚点是目标尺寸且新区域保持一致", () => {
  const executor = new ResizeExecutor(createPlan(baseInput), {
    failAt: "RELEASE_OLD_REGION",
  });
  const outcome = executor.run();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rollbackSizeMb, 1024);
  assert.equal(executor.env.activeRegion, "target");
  assert.equal(executor.env.regions.current.state, RegionState.RELEASE_PENDING);
});

test("锁表迁移完成前禁止释放旧区域：处理器内置守卫会拒绝", () => {
  const executor = new ResizeExecutor(createPlan(baseInput));
  const release = executor.plan.phases.find((item) => item.name === "RELEASE_OLD_REGION");
  // 直接构造未完成迁移的状态调用释放阶段，验证守卫逻辑。
  executor.env.lockTable.migrated = false;
  executor.env.activeRegion = "current";
  executor.env.connectionsRemapped = false;
  const result = executor.executePhase(release);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /禁止释放旧区域/);
  assert.equal(executor.env.regions.current.state, RegionState.ACTIVE);
});

test("连接静默与屏障阶段拒绝外部页访问", () => {
  const executor = new ResizeExecutor(createPlan(baseInput));
  const drain = executor.plan.phases.find((item) => item.name === "DRAIN_CONNECTIONS");
  executor.executePhase(drain);
  assert.equal(executor.isBlocked(Gate.CONNECTIONS), true);
  const barrierPhase = executor.plan.phases.find((item) => item.name === "MIGRATE_PAGE_CACHE");
  executor.executePhase(barrierPhase);
  assert.throws(() => executor.accessPage(0), ResourceBlockedError);
});
