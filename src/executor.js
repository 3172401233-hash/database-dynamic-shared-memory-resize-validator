// resize 执行器：按计划逐阶段推进，维护阻塞门控与页状态，
// 在注入故障或校验失败时基于阶段前快照回滚到一致尺寸。

import {
  Gate,
  RegionState,
  ResizeFailedError,
  ResourceBlockedError,
  createEnvironment,
} from "./model.js";

export class ResizeExecutor {
  constructor(plan, options = {}) {
    this.plan = plan;
    this.faults = new Map(Object.entries(options.faults ?? {}));
    if (options.failAt) {
      this.faults.set(options.failAt, new Error(`故障注入：${options.failAt}`));
    }
    this.env = createEnvironment(plan.request);
    this.env.blocked = [];
    this.completedPhases = [];
  }

  isBlocked(gate) {
    return this.env.blocked.includes(gate);
  }

  #block(gates) {
    for (const gate of gates) {
      if (!this.env.blocked.includes(gate)) {
        this.env.blocked.push(gate);
      }
    }
  }

  #unblockAll() {
    this.env.blocked = [];
  }

  #emit(type, detail = {}) {
    this.env.events.push({ type, at: this.completedPhases.length, ...detail });
  }

  // 模拟连接侧的页访问：映射屏障或页缓存阻塞期间必须被拒绝。
  accessPage(pageId) {
    if (this.isBlocked(Gate.MAPPING_BARRIER)) {
      throw new ResourceBlockedError(Gate.MAPPING_BARRIER);
    }
    if (this.isBlocked(Gate.PAGE_CACHE)) {
      throw new ResourceBlockedError(Gate.PAGE_CACHE);
    }
    const page = this.env.pageTable.get(pageId);
    if (!page || page.evicted) {
      return { blocked: false, faulted: false, missing: true };
    }
    const faulted = page.state === "swapped";
    if (faulted) {
      page.state = "resident";
      this.env.faultInCount += 1;
      this.#emit("page_fault_in", { pageId });
    }
    page.region = this.env.activeRegion;
    return { blocked: false, faulted, missing: false };
  }

  // 模拟脏页回写请求：屏障期外才允许，保证刷盘与页访问不会并发破坏映射。
  requestFlush(pageId) {
    if (this.isBlocked(Gate.MAPPING_BARRIER)) {
      throw new ResourceBlockedError(Gate.MAPPING_BARRIER);
    }
    if (this.isBlocked(Gate.CHECKPOINT) || this.isBlocked(Gate.PAGE_CACHE)) {
      throw new ResourceBlockedError(Gate.CHECKPOINT);
    }
    const page = this.env.pageTable.get(pageId);
    if (!page || page.evicted || !page.dirty) {
      return { flushed: false };
    }
    page.dirty = false;
    this.env.flushCount += 1;
    this.#emit("page_flush", { pageId });
    return { flushed: true };
  }

  getSnapshot() {
    return structuredClone({
      env: this.env,
      completedPhases: this.completedPhases,
    });
  }

  #restore(snapshot) {
    this.env = structuredClone(snapshot.env);
    this.completedPhases = [...snapshot.completedPhases];
  }

  #applyBlocks(phase) {
    this.#block(phase.blocks);
  }

  #runHandler(phase) {
    const { env, plan } = this;
    switch (phase.name) {
      case "VALIDATE_REQUEST":
        if (plan.expectedValidationFault) {
          throw new Error(plan.expectedValidationFault.message);
        }
        this.#emit("validated", { targetMb: plan.request.targetMb });
        break;
      case "ALLOCATE_TARGET_REGION":
        env.regions.target = {
          id: "target",
          sizeMb: plan.request.targetMb,
          state: RegionState.ACTIVE,
        };
        this.#emit("region_allocated", { sizeMb: plan.request.targetMb });
        break;
      case "QUIESCE_CHECKPOINT":
        if (env.checkpoint.active) {
          this.#emit("checkpoint_waited", { checkpointCount: env.checkpoint.count });
          env.checkpoint.active = false;
          env.checkpoint.count = 0;
        }
        break;
      case "DRAIN_CONNECTIONS":
        env.connectionsDrained = true;
        this.#emit("connections_drained", { count: env.activeConnections });
        break;
      case "MIGRATE_LOCK_TABLE":
        env.lockTable.region = "target";
        env.lockTable.migrated = true;
        this.#emit("lock_table_migrated", { to: "target" });
        break;
      case "MIGRATE_PAGE_CACHE": {
        let moved = 0;
        for (const page of env.pageTable.values()) {
          if (!page.evicted) {
            page.region = "target";
            moved += 1;
          }
        }
        env.pageCacheMb = Math.min(env.pageCacheMb, plan.request.targetMb);
        this.#emit("page_cache_migrated", { movedPages: moved });
        break;
      }
      case "REMAP_CONNECTIONS":
        env.connectionsRemapped = true;
        this.#emit("connections_remapped", { to: "target" });
        break;
      case "MAPPING_BARRIER":
        this.#emit("mapping_barrier_entered");
        break;
      case "COMMIT_NEW_REGION":
        env.activeRegion = "target";
        env.regions.current.state = RegionState.RELEASE_PENDING;
        this.#emit("region_committed", { activeSizeMb: plan.request.targetMb });
        break;
      case "RELEASE_OLD_REGION":
        if (!env.lockTable.migrated || env.activeRegion !== "target" || !env.connectionsRemapped) {
          throw new Error("锁表迁移或连接重定向未完成，禁止释放旧区域");
        }
        env.regions.current.state = RegionState.RELEASED;
        this.#emit("old_region_released");
        break;
      case "RESUME_WORKLOAD":
        this.#unblockAll();
        env.connectionsDrained = false;
        this.#emit("workload_resumed");
        break;
      case "MARK_SURPLUS_PAGES": {
        const surplus = phase.migration.surplusPages;
        const ids = [...env.pageTable.keys()].slice(-surplus);
        env.surplusPageIds = ids;
        for (const id of ids) {
          env.pageTable.get(id).surplus = true;
        }
        this.#emit("surplus_marked", { count: ids.length });
        break;
      }
      case "PAGE_IN_SWAPPED": {
        let faulted = 0;
        for (const page of env.pageTable.values()) {
          if (page.state === "swapped" && !page.evicted) {
            page.state = "resident";
            faulted += 1;
          }
        }
        env.faultInCount += faulted;
        this.#emit("swapped_pages_faulted_in", { count: faulted });
        break;
      }
      case "FLUSH_DIRTY_PAGES": {
        let flushed = 0;
        for (const page of env.pageTable.values()) {
          if (page.dirty && !page.evicted) {
            page.dirty = false;
            flushed += 1;
          }
        }
        env.flushCount += flushed;
        this.#emit("dirty_pages_flushed", { count: flushed });
        break;
      }
      case "EVICT_SURPLUS_PAGES": {
        let evicted = 0;
        for (const id of env.surplusPageIds ?? []) {
          const page = env.pageTable.get(id);
          if (page.dirty) {
            throw new Error(`富余页 ${id} 仍为脏页，驱逐前必须先刷盘`);
          }
          page.evicted = true;
          page.state = "evicted";
          evicted += 1;
        }
        const evictedMb = evicted * 4;
        env.pageCacheMb = Math.max(0, env.pageCacheMb - evictedMb);
        this.#emit("surplus_evicted", { count: evicted });
        break;
      }
      default:
        throw new Error(`未知阶段 ${phase.name}`);
    }
  }

  // 执行单个阶段：先拍快照、再上门控、检测注入故障、执行处理器。
  executePhase(phase) {
    this.#applyBlocks(phase);

    const injected = this.faults.get(phase.name);
    if (injected) {
      return this.#rollback(phase, injected, this.getSnapshot());
    }

    const snapshot = this.getSnapshot();
    try {
      this.#runHandler(phase);
    } catch (error) {
      return this.#rollback(phase, error, snapshot);
    }

    this.completedPhases.push(phase.name);
    return { ok: true, phase: phase.name };
  }

  #rollback(phase, error, snapshot) {
    this.#restore(snapshot);
    // 若失败发生在锁表迁移之后，快照中锁表可能已指向新区域，
    // 一致回滚要求把锁表迁回仍活跃的旧区域。
    if (this.env.lockTable.migrated && this.env.activeRegion === "current") {
      this.env.lockTable.region = "current";
      this.env.lockTable.migrated = false;
      this.#emit("lock_table_rollback", { to: "current" });
    }
    if (this.env.connectionsRemapped) {
      this.env.connectionsRemapped = false;
    }
    // 恢复到阶段前的一致状态后解除门控，让工作负载在一致尺寸上继续。
    this.#unblockAll();
    this.env.connectionsDrained = false;
    const activeRegion = this.env.regions[this.env.activeRegion];
    const rollbackSizeMb = activeRegion.sizeMb;
    this.#emit("rollback", {
      failedPhase: phase.name,
      rollbackSizeMb,
      reason: error.message,
    });
    const wrapped = new ResizeFailedError(phase.name, error, rollbackSizeMb);
    return {
      ok: false,
      phase: phase.name,
      error: wrapped,
      rollbackSizeMb,
      events: [...this.env.events],
      env: this.env,
    };
  }

  run() {
    for (const phase of this.plan.phases) {
      const outcome = this.executePhase(phase);
      if (!outcome.ok) {
        return outcome;
      }
    }
    return {
      ok: true,
      committedSizeMb: this.plan.request.targetMb,
      completedPhases: [...this.completedPhases],
      events: [...this.env.events],
      env: this.env,
    };
  }
}

export function executePlan(plan, options = {}) {
  return new ResizeExecutor(plan, options).run();
}
