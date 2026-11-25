#!/usr/bin/env node
// 命令行入口：打印 resize 阶段顺序、阻塞资源、页迁移与回滚点，并可选执行模拟。
// 本工具只做内存中的逻辑模拟，不会连接或操作任何真实数据库。

import { createPlan } from "./planner.js";
import { ResizeExecutor } from "./executor.js";
import { ResizeValidationError } from "./model.js";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    if (key === "json" || key === "plan-only") {
      args[key] = true;
    } else {
      args[key] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function toRequest(args) {
  return {
    currentMb: args.current,
    targetMb: args.target,
    activeConnections: args.connections ?? 0,
    pageCacheMb: args["page-cache"] ?? 0,
    lockTableMb: args["lock-table"] ?? 0,
    checkpointActive: args.checkpoint === "true" || args.checkpoint === "1",
    dirtyPages: args["dirty-pages"] ?? 0,
    swappedPages: args["swapped-pages"] ?? 0,
    memoryPressureMb: args.pressure ?? 0,
  };
}

function printPlan(plan) {
  console.log(`方向: ${plan.direction}  ${plan.request.currentMb}MB -> ${plan.request.targetMb}MB`);
  console.log("阶段顺序 / 阻塞资源 / 页迁移 / 回滚点:");
  for (const item of plan.phases) {
    const blocks = item.blocks.length ? item.blocks.join(",") : "-";
    const migration = item.migration ? `${item.migration.kind}${
      item.migration.pages !== undefined ? `(${item.migration.pages})` : ""
    }` : "-";
    const exclusive = item.exclusive ? " [互斥屏障]" : "";
    console.log(
      `  ${String(item.index).padStart(2, "0")} ${item.name}${exclusive}\n` +
        `       阻塞: ${blocks} | 迁移: ${migration} | 回滚: ${item.rollbackPoint.sizeMb}MB`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let plan;
  try {
    plan = createPlan(toRequest(args));
  } catch (error) {
    if (error instanceof ResizeValidationError) {
      console.error(`输入校验失败: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  printPlan(plan);

  if (args["plan-only"]) {
    if (plan.expectedValidationFault) {
      console.error(`\n执行将失败并回滚: ${plan.expectedValidationFault.message}`);
      process.exit(1);
    }
    return;
  }

  const outcome = new ResizeExecutor(plan).run();
  if (!outcome.ok) {
    console.error(`\n执行失败并已回滚: ${outcome.error.message}`);
    process.exit(1);
  }
  console.log(`\n模拟提交成功，一致尺寸: ${outcome.committedSizeMb}MB`);
  console.log(`事件: ${outcome.events.map((event) => event.type).join(" -> ")}`);
}

main();
