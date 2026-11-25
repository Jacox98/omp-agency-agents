import { expect, test } from "bun:test";
import { truncateToWidth, wrapTextWithAnsi } from "../src/text";

test.each([
	["plain text", "Frontend Developer", 9, "Frontend…"],
	["wide characters stay whole", "日本語のテキスト", 7, "日本語…"],
	["emoji clusters stay whole", "👩‍💻👩‍💻👩‍💻", 5, "👩‍💻👩‍💻…"],
	["fitting text is unchanged", "short", 10, "short"],
])("truncateToWidth: %s", (_name, text, width, expected) => {
	const out = truncateToWidth(text, width);
	expect(out).toBe(expected);
	expect(Bun.stringWidth(out)).toBeLessThanOrEqual(width);
});

test("truncateToWidth keeps styles balanced and pads to the width", () => {
	const out = truncateToWidth("\x1b[31mred text here\x1b[0m", 6, "…", true);
	expect(Bun.stripANSI(out)).toBe("red t…");
	expect(out.startsWith("\x1b[31m")).toBe(true);
	expect(out.endsWith("\x1b[0m")).toBe(true);
	expect(truncateToWidth("ab", 5, "…", true)).toBe("ab   ");
	expect(truncateToWidth("abc", 0)).toBe("");
});

test("wrapTextWithAnsi never exceeds the width", () => {
	const lines = wrapTextWithAnsi("\x1b[1mA verylongwordthatmustbreak and more\x1b[0m", 8);
	expect(lines.length).toBeGreaterThan(1);
	expect(lines.every(line => Bun.stringWidth(line) <= 8)).toBe(true);
});
