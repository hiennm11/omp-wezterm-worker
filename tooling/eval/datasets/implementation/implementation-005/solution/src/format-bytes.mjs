export function formatBytes(count) {
	if (count < 1024) {
		return `${count} B`;
	}
	if (count < 1024 * 1024) {
		return `${count / 1024} KB`;
	}
	return `${count / (1024 * 1024)} MB`;
}
