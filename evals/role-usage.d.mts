export interface RoleUsage {
	calls: number;
	models: string[];
	modelNotReported: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_usd: number;
}

export function aggregateRoleUsage(dirs: string[]): Record<string, RoleUsage>;
