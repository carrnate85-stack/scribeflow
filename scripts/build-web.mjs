import { spawnSync } from "node:child_process";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpmCommand, ["run", "build"], {
  env: {
    ...process.env,
    VITE_SCRIBEFLOW_WEB: "1",
  },
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
