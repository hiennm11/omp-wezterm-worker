export function parseRecord(text) {
	const fields = {};
	for (const part of text.split(",")) {
		const index = part.indexOf("=");
		fields[part.slice(0, index)] = part.slice(index + 1);
	}
	const count = fields.count === undefined ? 0 : Number(fields.count);
	return { name: fields.name, count };
}
