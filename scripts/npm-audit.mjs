// Production dependency audit used by native bundling and release checks.
// The gate fails on every advisory reported for the target install tree.
// Usage: node scripts/npm-audit.mjs [--prefix <dir>]
import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["audit", "--omit=dev", "--json", ...process.argv.slice(2)], {
	encoding: "utf8",
	shell: process.platform === "win32",
	stdio: ["ignore", "pipe", "inherit"],
});
let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	console.error(`npm audit did not return JSON (exit ${result.status}).`);
	process.exit(1);
}

const blocking = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
	const nodes = vulnerability.nodes ?? [];
	// Entries whose `via` is only package names inherit an advisory listed on another entry.
	for (const via of vulnerability.via.filter((entry) => typeof entry === "object")) {
		blocking.push(`${name}: ${via.title} ${via.url} [${via.severity}] at ${nodes.join(", ")}`);
	}
}

if (blocking.length > 0) {
	console.error(`npm audit found ${blocking.length} blocking advisories:\n${blocking.join("\n")}`);
	process.exit(1);
}
console.log("npm audit: no blocking advisories");
