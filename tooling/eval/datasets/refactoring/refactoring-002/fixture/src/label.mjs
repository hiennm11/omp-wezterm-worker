import { toUpper } from "./text.mjs";

export function label(text) {
	return `name: ${toUpper(text)}`;
}
