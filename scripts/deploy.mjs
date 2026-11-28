// Deploy with secrets from the shared ../.env, then always delete the temporary secrets file.
// Usage: npm run deploy [-- <extra cf deploy args>]
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const file = ".secrets.deploy.json";
const run = (cmd, args) =>
	spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });

let status = 1;
try {
	if (run("node", ["scripts/secrets.mjs", file]).status !== 0) process.exit(1);
	status =
		run("npx", ["cf", "deploy", "--secrets-file", file, ...process.argv.slice(2)]).status ?? 1;
} finally {
	rmSync(file, { force: true });
}
process.exit(status);
