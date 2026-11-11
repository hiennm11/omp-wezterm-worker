export function levelFor(score) {
	if (score >= 80) {
		return "high";
	}
	if (score >= 50) {
		return "medium";
	}
	return "low";
}
