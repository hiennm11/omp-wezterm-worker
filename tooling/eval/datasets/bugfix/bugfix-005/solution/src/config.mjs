export function mergeConfig(defaults, overrides) {
	return { ...defaults, ...overrides };
}
