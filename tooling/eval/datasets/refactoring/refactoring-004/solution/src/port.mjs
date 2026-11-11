export function isValidPort(port) {
	return Number.isInteger(port);
}

export function parsePort(text) {
	const port = Number(text);
	if (!isValidPort(port)) {
		return null;
	}
	return port;
}
