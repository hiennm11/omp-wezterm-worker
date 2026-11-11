export function parseRecord(text) {
	const fields = {};
	for (const part of text.split(",")) {
		const index = part.indexOf("=");
		fields[part.slice(0, index)] = part.slice(index + 1);
	}
	return { name: fields.name, count: Number(fields.count) };
}
