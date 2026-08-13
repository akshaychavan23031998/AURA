import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const interpreter = join(
  repositoryRoot,
  "services",
  "voice",
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
if (!existsSync(interpreter)) {
  console.error(
    "Voice Python environment is missing. Create services/voice/.venv and install services/voice with its development dependencies.",
  );
  process.exitCode = 1;
} else {
  const result = spawnSync(interpreter, process.argv.slice(2), {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(
      `Unable to run the Voice Python interpreter: ${result.error.message}`,
    );
    process.exitCode = 1;
  } else if (result.signal !== null) {
    console.error(
      `Voice Python process terminated by signal ${result.signal}.`,
    );
    process.exitCode = 1;
  } else process.exitCode = result.status ?? 1;
}
