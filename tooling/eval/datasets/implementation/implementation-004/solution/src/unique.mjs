export function unique(items) {
	const seen = new Set();
	const result = [];
	for (const item of items) {
		if (seen.has(item)) {
			continue;
		}
		seen.add(item);
		result.push(item);
	}
	return result;
}
