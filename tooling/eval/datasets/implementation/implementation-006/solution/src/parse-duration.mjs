export function parseDuration(text) {
	const pattern = /(\d+)(h|m|s)/g;
	const units = { h: 3600000, m: 60000, s: 1000 };
	let total = 0;
	for (const match of text.matchAll(pattern)) {
		total += Number(match[1]) * units[match[2]];
	}
	return total;
}
