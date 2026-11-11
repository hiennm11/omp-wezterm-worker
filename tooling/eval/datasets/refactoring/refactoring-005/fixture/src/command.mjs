export function runCommand(text) {
	const parts = text.split(" ");
	const action = parts[0];
	const value = Number(parts[1]);
	if (action === "double") {
		return value * 2;
	}
	return value;
}
