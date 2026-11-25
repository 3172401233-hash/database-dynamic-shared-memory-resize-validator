// 共享内存扩缩容验证器的领域模型与输入归一化（纯内存模拟，不接触任何真实数据库资源）。

export const PAGE_SIZE_MB = 4;

export const Direction = Object.freeze({
  GROW: "grow",
  SHRINK: "shrink",
});

export const Gate = Object.freeze({
  CONNECTIONS: "connections",
  LOCK_TABLE: "lock_table",
  PAGE_CACHE: "page_cache",
  CHECKPOINT: "checkpoint",
  MAPPING_BARRIER: "mapping_barrier",
});

export const RegionState = Object.freeze({
  ACTIVE: "active",
  RELEASE_PENDING: "release_pending",
  RELEASED: "released",
});

export class ResizeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResizeValidationError";
  }
}

export class ResourceBlockedError extends Error {
  constructor(gate) {
    super(`资源 ${gate} 正被 resize 阶段阻塞`);
    this.name = "ResourceBlockedError";
    this.gate = gate;
  }
}

export class ResizeFailedError extends Error {
  constructor(phase, cause, rollbackSizeMb) {
    super(`阶段 ${phase} 失败：${cause.message}；已回滚到一致尺寸 ${rollbackSizeMb}MB`);
    this.name = "ResizeFailedError";
    this.phase = phase;
    this.cause = cause;
    this.rollbackSizeMb = rollbackSizeMb;
  }
}

function nonNegativeInt(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || !Number.isInteger(num)) {
    throw new ResizeValidationError(`${field} 必须是非负整数，实际收到 ${String(value)}`);
  }
  return num;
}

// 将 CLI / 调用方输入归一化为 ResizeRequest。
// memoryPressureMb 表示当前可用于扩容的内存余量（MB）。
export function normalizeRequest(input = {}) {
  const currentMb = nonNegativeInt(input.currentMb ?? input.current, "currentMb");
  const targetMb = nonNegativeInt(input.targetMb ?? input.target, "targetMb");
  if (currentMb === 0) {
    throw new ResizeValidationError("当前共享内存区域大小必须大于 0");
  }
  if (currentMb === targetMb) {
    throw new ResizeValidationError(`目标大小与当前大小相同（${currentMb}MB），无需 resize`);
  }

  const activeConnections = nonNegativeInt(input.activeConnections ?? input.connections, "activeConnections");
  const pageCacheMb = nonNegativeInt(input.pageCacheMb ?? input.pageCache, "pageCacheMb");
  const lockTableMb = nonNegativeInt(input.lockTableMb ?? input.lockTable, "lockTableMb");
  const checkpointActive = Boolean(input.checkpointActive ?? input.checkpoint ?? false);
  const dirtyPages = nonNegativeInt(input.dirtyPages ?? input.dirtyPageCount, "dirtyPages");
  const swappedPages = nonNegativeInt(input.swappedPages ?? 0, "swappedPages");
  const memoryPressureMb = nonNegativeInt(
    input.memoryPressureMb ?? input.memoryPressure ?? 0,
    "memoryPressureMb",
  );

  if (pageCacheMb > currentMb) {
    throw new ResizeValidationError("页缓存不能大于当前共享内存区域");
  }
  if (lockTableMb > currentMb) {
    throw new ResizeValidationError("锁表不能大于当前共享内存区域");
  }

  const totalPages = Math.ceil(currentMb / PAGE_SIZE_MB);
  const dirtyPageCount = Math.min(dirtyPages, totalPages);
  const swappedPageCount = Math.min(swappedPages, totalPages);

  return Object.freeze({
    currentMb,
    targetMb,
    direction: targetMb > currentMb ? Direction.GROW : Direction.SHRINK,
    activeConnections,
    pageCacheMb,
    lockTableMb,
    checkpointActive,
    dirtyPageCount,
    swappedPageCount,
    memoryPressureMb,
  });
}

// 模拟数据库运行环境：当前区域、新区域、页缓存、锁表、连接与检查点状态。
export function createEnvironment(request) {
  const totalPages = Math.ceil(request.currentMb / PAGE_SIZE_MB);
  const pageTable = new Map();
  for (let index = 0; index < totalPages; index += 1) {
    const swapped = index < request.swappedPageCount;
    const dirty = index < request.dirtyPageCount;
    pageTable.set(index, {
      id: index,
      region: "current",
      state: swapped ? "swapped" : "resident",
      dirty,
      evicted: false,
    });
  }

  return {
    regions: {
      current: { id: "current", sizeMb: request.currentMb, state: RegionState.ACTIVE },
      target: null,
    },
    activeRegion: "current",
    activeConnections: request.activeConnections,
    connectionsDrained: false,
    lockTable: { region: "current", migrated: false, sizeMb: request.lockTableMb },
    pageCacheMb: request.pageCacheMb,
    pageTable,
    checkpoint: { active: request.checkpointActive, count: request.checkpointActive ? 1 : 0 },
    flushCount: 0,
    faultInCount: 0,
    events: [],
  };
}
