export function mergeConfig(defaults, overrides) {
	const merged = {};
	for (const key of Object.keys(defaults)) {
		merged[key] = overrides[key];
	}
	return merged;
}
