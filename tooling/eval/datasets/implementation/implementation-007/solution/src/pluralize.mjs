export function pluralize(count, word) {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}
