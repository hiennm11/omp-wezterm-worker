export function parseCommand(text) {
	const parts = text.split(" ");
	return { action: parts[0], value: Number(parts[1]) };
}

export function applyCommand(parsed) {
	if (parsed.action === "double") {
		return parsed.value * 2;
	}
	return parsed.value;
}

export function runCommand(text) {
	return applyCommand(parseCommand(text));
}
