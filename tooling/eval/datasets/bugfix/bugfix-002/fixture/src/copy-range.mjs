export function copyRange(items, end) {
	const copy = [];
	for (let index = 0; index <= end; index += 1) {
		copy.push(items[index]);
	}
	return copy;
}
