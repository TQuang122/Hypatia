import { objectHash } from "./files.js";
import type { Contract, EnvironmentFingerprint } from "./schema.js";

export type EnvironmentFingerprintHost = {
	readonly platform: string;
	readonly architecture: string;
	readonly runtimeVersion: string;
};

export function currentEnvironmentFingerprintHost(): EnvironmentFingerprintHost {
	return {
		platform: process.platform,
		architecture: process.arch,
		runtimeVersion: process.version,
	};
}

export function fingerprintEnvironment(
	contract: Pick<Contract, "environment" | "executableHash" | "inputHashes">,
	host = currentEnvironmentFingerprintHost(),
): EnvironmentFingerprint {
	const inputFilesHash = objectHash(contract.inputHashes);
	const manifest = {
		version: 1,
		environment: contract.environment,
		platform: host.platform,
		architecture: host.architecture,
		runtimeVersion: host.runtimeVersion,
		executableHash: contract.executableHash,
		inputFilesHash,
	};
	return {
		version: 1,
		platform: host.platform,
		architecture: host.architecture,
		runtimeVersion: host.runtimeVersion,
		executableHash: contract.executableHash,
		inputFilesHash,
		sha256: objectHash(manifest),
	};
}
