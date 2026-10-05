import { main } from "../../src/runner/pi.js";
import { watch } from "node:fs";

// Real CLI lifecycle without importing the runner's CLI auto-start condition.
// Cancel only after the real bridge creates its owned admission/worker scratch.
let canceled = false;
const watcher = process.env.LEVERET_FIXTURE_CANCEL === "1" ? watch(process.env.TMPDIR!, { recursive: true }, (_event, name) => {
  if (!canceled && name?.toString().includes("inspect-java-")) {
    canceled = true;
    process.kill(process.pid, "SIGTERM");
  }
}) : undefined;
await main().catch(() => { process.exitCode = 1; });
watcher?.close();
