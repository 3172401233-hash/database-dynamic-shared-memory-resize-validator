import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

const commonArgs = [
  "--current",
  "512",
  "--target",
  "1024",
  "--connections",
  "8",
  "--page-cache",
  "256",
  "--lock-table",
  "64",
  "--checkpoint",
  "true",
  "--dirty-pages",
  "40",
  "--swapped-pages",
  "8",
  "--pressure",
  "2048",
];

test("CLI 文本模式输出阶段顺序、阻塞资源与回滚点", async () => {
  const { stdout } = await exec(process.execPath, [cliPath, ...commonArgs]);
  assert.match(stdout, /MIGRATE_LOCK_TABLE/);
  assert.match(stdout, /阻塞: lock_table,connections/);
  assert.match(stdout, /回滚: 512MB/);
  assert.match(stdout, /模拟提交成功，一致尺寸: 1024MB/);
});

test("CLI --json 输出可解析的完整计划", async () => {
  const { stdout } = await exec(process.execPath, [cliPath, ...commonArgs, "--json"]);
  const plan = JSON.parse(stdout);
  assert.equal(plan.phases.length, 11);
  assert.equal(plan.direction, "grow");
});

test("CLI 校验失败以非零码退出并提示原因", async () => {
  await assert.rejects(
    exec(process.execPath, [
      cliPath,
      "--current",
      "512",
      "--target",
      "1024",
      "--pressure",
      "10",
      "--plan-only",
    ]),
    (error) => (error.code === 1 || error.status === 1) && /执行将失败并回滚/.test(error.stderr),
  );
});

test("CLI 输入非法时退出码为 2", async () => {
  await assert.rejects(
    exec(process.execPath, [cliPath, "--current", "512", "--target", "512"]),
    (error) => error.code === 2 && /输入校验失败/.test(error.stderr),
  );
});
