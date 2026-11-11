export function parsePort(text) {
	const port = Number(text);
	if (!Number.isInteger(port)) {
		return null;
	}
	return port;
}
