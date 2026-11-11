export function chunk(items, size) {
	const parts = [];
	for (let index = 0; index < items.length; index += size) {
		parts.push(items.slice(index, index + size));
	}
	return parts;
}
