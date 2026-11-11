export function titleCase(text) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export function slugify(text) {
	return text.toLowerCase().replace(/ /g, "-");
}
