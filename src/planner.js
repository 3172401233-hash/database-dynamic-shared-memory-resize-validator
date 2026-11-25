// resize 阶段规划器：根据方向生成有序阶段、阻塞资源、页迁移动作与回滚点。
// 规划结果是纯数据，可被序列化、审计与重复执行。

import { Direction, Gate, PAGE_SIZE_MB, ResizeValidationError, normalizeRequest } from "./model.js";

const { CONNECTIONS, LOCK_TABLE, PAGE_CACHE, CHECKPOINT, MAPPING_BARRIER } = Gate;

let phaseSequence = 0;

function phase(name, label, options = {}) {
  phaseSequence += 1;
  return {
    index: phaseSequence,
    name,
    label,
    blocks: options.blocks ?? [],
    exclusive: options.exclusive ?? false,
    action: options.action ?? name.toLowerCase(),
    migration: options.migration ?? null,
    rollbackPoint: options.rollbackPoint,
  };
}

function rollback(sizeMb, label) {
  return { sizeMb, label };
}

function surplusPages(request) {
  const keepPages = Math.ceil(request.targetMb / PAGE_SIZE_MB);
  const totalPages = Math.ceil(request.currentMb / PAGE_SIZE_MB);
  return Math.max(0, totalPages - keepPages);
}

// 扩容阶段：旧区域在锁表迁移完成前始终保持 ACTIVE，不能释放。
function growPhases(request) {
  const base = rollback(request.currentMb, "保留旧区域，恢复原尺寸");
  const target = rollback(request.targetMb, "新区域已提交，回滚到目标尺寸");
  const addedPages = Math.ceil(request.targetMb / PAGE_SIZE_MB) - Math.ceil(request.currentMb / PAGE_SIZE_MB);

  return [
    phase("VALIDATE_REQUEST", "校验扩容请求与内存余量", {
      blocks: [],
      rollbackPoint: base,
    }),
    phase("ALLOCATE_TARGET_REGION", "映射新的目标共享内存区域", {
      blocks: [],
      migration: { kind: "allocate_region", targetMb: request.targetMb },
      rollbackPoint: base,
    }),
    phase("QUIESCE_CHECKPOINT", "等待未完成 checkpoint 结束并暂停新 checkpoint", {
      blocks: [CHECKPOINT],
      rollbackPoint: base,
    }),
    phase("DRAIN_CONNECTIONS", "阻塞并静默活跃连接", {
      blocks: [CONNECTIONS],
      rollbackPoint: base,
    }),
    phase("MIGRATE_LOCK_TABLE", "迁移锁表到新区域（完成前禁止释放旧区域）", {
      blocks: [LOCK_TABLE, CONNECTIONS],
      migration: { kind: "lock_table", from: "current", to: "target" },
      rollbackPoint: base,
    }),
    phase("MIGRATE_PAGE_CACHE", "持映射屏障迁移页缓存与页表到新区域", {
      blocks: [PAGE_CACHE, MAPPING_BARRIER, CONNECTIONS],
      exclusive: true,
      migration: { kind: "page_cache", direction: Direction.GROW, movedPages: addedPages },
      rollbackPoint: base,
    }),
    phase("REMAP_CONNECTIONS", "将连接句柄重定向到新区域", {
      blocks: [CONNECTIONS, LOCK_TABLE],
      migration: { kind: "connection_remap", to: "target" },
      rollbackPoint: base,
    }),
    phase("MAPPING_BARRIER", "映射屏障：串行化页访问与脏页刷盘", {
      blocks: [CONNECTIONS, LOCK_TABLE, PAGE_CACHE, CHECKPOINT, MAPPING_BARRIER],
      exclusive: true,
      rollbackPoint: base,
    }),
    phase("COMMIT_NEW_REGION", "提交新区域为活跃区域（一致尺寸切换点）", {
      blocks: [MAPPING_BARRIER],
      migration: { kind: "commit_region", targetMb: request.targetMb },
      rollbackPoint: target,
    }),
    phase("RELEASE_OLD_REGION", "锁表已迁移且连接已重定向，释放旧区域", {
      blocks: [LOCK_TABLE, MAPPING_BARRIER],
      migration: { kind: "release_region", region: "current" },
      rollbackPoint: target,
    }),
    phase("RESUME_WORKLOAD", "解除全部阻塞并恢复工作负载", {
      blocks: [],
      rollbackPoint: target,
    }),
  ];
}

// 缩容阶段：先处理被换出后又被访问的页与脏页，再驱逐富余页，最后迁移并切换。
function shrinkPhases(request) {
  const base = rollback(request.currentMb, "保留旧区域，恢复原尺寸");
  const target = rollback(request.targetMb, "新区域已提交，回滚到目标尺寸");
  const evictCount = surplusPages(request);
  const keepPages = Math.ceil(request.targetMb / PAGE_SIZE_MB);

  return [
    phase("VALIDATE_REQUEST", "校验缩容请求与最小容量", {
      blocks: [],
      rollbackPoint: base,
    }),
    phase("QUIESCE_CHECKPOINT", "等待未完成 checkpoint 结束并暂停新 checkpoint", {
      blocks: [CHECKPOINT],
      rollbackPoint: base,
    }),
    phase("MARK_SURPLUS_PAGES", `标记 ${evictCount} 个待驱逐富余页`, {
      blocks: [PAGE_CACHE],
      migration: { kind: "mark_surplus", surplusPages: evictCount },
      rollbackPoint: base,
    }),
    phase("PAGE_IN_SWAPPED", "换入被换出后又被访问的页面", {
      blocks: [PAGE_CACHE, MAPPING_BARRIER],
      exclusive: true,
      migration: { kind: "page_in_swapped", pages: request.swappedPageCount },
      rollbackPoint: base,
    }),
    phase("FLUSH_DIRTY_PAGES", "脏页刷盘（与页访问互斥，防止映射被并发破坏）", {
      blocks: [PAGE_CACHE, MAPPING_BARRIER, CHECKPOINT],
      exclusive: true,
      migration: { kind: "flush_dirty", pages: request.dirtyPageCount },
      rollbackPoint: base,
    }),
    phase("EVICT_SURPLUS_PAGES", "驱逐富余页并收缩页缓存", {
      blocks: [PAGE_CACHE, MAPPING_BARRIER],
      exclusive: true,
      migration: { kind: "evict_surplus", pages: evictCount },
      rollbackPoint: base,
    }),
    phase("DRAIN_CONNECTIONS", "阻塞并静默活跃连接", {
      blocks: [CONNECTIONS],
      rollbackPoint: base,
    }),
    phase("MIGRATE_LOCK_TABLE", "迁移锁表到收缩后的新区域（完成前禁止释放旧区域）", {
      blocks: [LOCK_TABLE, CONNECTIONS],
      migration: { kind: "lock_table", from: "current", to: "target" },
      rollbackPoint: base,
    }),
    phase("MIGRATE_PAGE_CACHE", "持映射屏障迁移保留页到新区域", {
      blocks: [PAGE_CACHE, MAPPING_BARRIER, CONNECTIONS],
      exclusive: true,
      migration: { kind: "page_cache", direction: Direction.SHRINK, movedPages: keepPages },
      rollbackPoint: base,
    }),
    phase("REMAP_CONNECTIONS", "将连接句柄重定向到新区域", {
      blocks: [CONNECTIONS, LOCK_TABLE],
      migration: { kind: "connection_remap", to: "target" },
      rollbackPoint: base,
    }),
    phase("MAPPING_BARRIER", "映射屏障：串行化页访问与脏页刷盘", {
      blocks: [CONNECTIONS, LOCK_TABLE, PAGE_CACHE, CHECKPOINT, MAPPING_BARRIER],
      exclusive: true,
      rollbackPoint: base,
    }),
    phase("COMMIT_NEW_REGION", "提交收缩区域为活跃区域（一致尺寸切换点）", {
      blocks: [MAPPING_BARRIER],
      migration: { kind: "commit_region", targetMb: request.targetMb },
      rollbackPoint: target,
    }),
    phase("RELEASE_OLD_REGION", "锁表已迁移且连接已重定向，释放旧区域", {
      blocks: [LOCK_TABLE, MAPPING_BARRIER],
      migration: { kind: "release_region", region: "current" },
      rollbackPoint: target,
    }),
    phase("RESUME_WORKLOAD", "解除全部阻塞并恢复工作负载", {
      blocks: [],
      rollbackPoint: target,
    }),
  ];
}

export function createPlan(rawInput) {
  phaseSequence = 0;
  const request = normalizeRequest(rawInput);
  const phases = request.direction === Direction.GROW ? growPhases(request) : shrinkPhases(request);

  const plan = {
    direction: request.direction,
    request,
    phases,
    // VALIDATE 阶段执行时据此判定可预期失败（内存余量不足 / 容量不足）。
    expectedValidationFault: buildValidationFault(request),
  };
  const verification = verifyPlan(plan);
  if (!verification.ok) {
    throw new ResizeValidationError(`生成的 resize 计划违反不变式：${verification.violations.join("；")}`);
  }
  return plan;
}

function buildValidationFault(request) {
  if (request.direction === Direction.GROW) {
    const deltaMb = request.targetMb - request.currentMb;
    if (deltaMb > request.memoryPressureMb) {
      return {
        phase: "VALIDATE_REQUEST",
        message: `内存余量 ${request.memoryPressureMb}MB 小于扩容增量 ${deltaMb}MB`,
      };
    }
  } else if (request.targetMb < Math.max(request.lockTableMb, PAGE_SIZE_MB)) {
    return {
      phase: "VALIDATE_REQUEST",
      message: `目标尺寸 ${request.targetMb}MB 无法容纳锁表 ${request.lockTableMb}MB 与最小页 ${PAGE_SIZE_MB}MB`,
    };
  }
  return null;
}

// 计划级不变式校验：阶段顺序、锁表迁移先于旧区域释放、屏障互斥与回滚点一致性。
export function verifyPlan(plan) {
  const violations = [];
  const indexOf = (name) => plan.phases.findIndex((item) => item.name === name);

  if (plan.phases[0]?.name !== "VALIDATE_REQUEST") {
    violations.push("首个阶段必须是 VALIDATE_REQUEST");
  }
  if (plan.phases.at(-1)?.name !== "RESUME_WORKLOAD") {
    violations.push("末尾阶段必须是 RESUME_WORKLOAD");
  }

  const lockMigration = indexOf("MIGRATE_LOCK_TABLE");
  const releaseOld = indexOf("RELEASE_OLD_REGION");
  const commit = indexOf("COMMIT_NEW_REGION");
  const barrier = indexOf("MAPPING_BARRIER");

  if (lockMigration === -1 || releaseOld === -1 || commit === -1) {
    violations.push("缺少锁表迁移、提交或旧区域释放阶段");
  } else {
    if (!(lockMigration < releaseOld)) {
      violations.push("旧区域释放必须晚于锁表迁移完成");
    }
    if (!(commit < releaseOld)) {
      violations.push("旧区域释放必须晚于新区域提交");
    }
    if (!(barrier > -1 && barrier < commit)) {
      violations.push("提交前必须经过映射屏障");
    }
  }

  for (const item of plan.phases) {
    if (!item.rollbackPoint || !Number.isInteger(item.rollbackPoint.sizeMb)) {
      violations.push(`阶段 ${item.name} 缺少有效回滚点`);
    }
    if (item.exclusive && !item.blocks.includes(Gate.MAPPING_BARRIER)) {
      violations.push(`互斥阶段 ${item.name} 必须持有映射屏障`);
    }
  }

  const flush = plan.phases.find((item) => item.name === "FLUSH_DIRTY_PAGES");
  if (flush && !flush.exclusive) {
    violations.push("脏页刷盘必须在互斥屏障内执行");
  }

  return { ok: violations.length === 0, violations };
}
