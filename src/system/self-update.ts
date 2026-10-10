export const HYPATIA_PACKAGE_NAME = "@tquang122/hypatia";
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${HYPATIA_PACKAGE_NAME}/latest`;

function parseVersion(version: string): number[] | undefined {
	const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return undefined;
	return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3]!, 10)];
}

export function isNewerVersion(candidate: string, current: string): boolean {
	const parsedCandidate = parseVersion(candidate);
	const parsedCurrent = parseVersion(current);
	if (!parsedCandidate || !parsedCurrent) return false;
	for (let index = 0; index < 3; index += 1) {
		if (parsedCandidate[index]! !== parsedCurrent[index]!) {
			return parsedCandidate[index]! > parsedCurrent[index]!;
		}
	}
	return false;
}

export async function fetchLatestHypatiaVersion(timeoutMs = 5000): Promise<string | undefined> {
	try {
		const response = await fetch(REGISTRY_LATEST_URL, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { version?: unknown };
		return typeof data.version === "string" && parseVersion(data.version) ? data.version : undefined;
	} catch {
		return undefined;
	}
}

export function getHypatiaUpgradeLines(
	latestVersion: string,
	currentVersion: string,
	options: { standaloneBundle: boolean; platform?: NodeJS.Platform },
): string[] {
	const platform = options.platform ?? process.platform;
	const upgradeCommand = options.standaloneBundle
		? platform === "win32"
			? "irm https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.ps1 | iex"
			: "curl -fsSL https://raw.githubusercontent.com/TQuang122/hypatia/main/scripts/install/install.sh | bash"
		: `npm install -g ${HYPATIA_PACKAGE_NAME}`;
	return [
		`A newer Hypatia is available: ${latestVersion} (installed ${currentVersion}).`,
		`Update the CLI itself with: ${upgradeCommand}`,
	];
}
