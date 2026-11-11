export function headerValue(headers, name) {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === wanted) {
			return headers[key];
		}
	}
	return undefined;
}
