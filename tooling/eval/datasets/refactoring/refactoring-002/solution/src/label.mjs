import { uppercase } from "./text.mjs";

export function label(text) {
	return `name: ${uppercase(text)}`;
}
