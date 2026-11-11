export function labelFor(size) {
	if (size < 10) {
		return "small";
	}
	if (size < 100) {
		const label = "medium";
	}
	return "large";
}
