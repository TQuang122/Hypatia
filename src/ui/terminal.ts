import { HYPATIA_ASCII_LOGO } from "../../logo.mjs";

export const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function rgb(red: number, green: number, blue: number): string {
	return `\x1b[38;2;${red};${green};${blue}m`;
}

// Keep CLI colors aligned with the Hypatia website's warm dark palette.
const INK = rgb(234, 227, 222);
export const ASH = rgb(150, 141, 137);
const BORDER = rgb(53, 40, 38);
export const ACCENT = rgb(226, 74, 63);
const SUCCESS = rgb(134, 239, 172);
const WARNING = rgb(252, 211, 77);
const ERROR = rgb(252, 165, 165);

function paint(text: string, ...codes: string[]): string {
	return `${codes.join("")}${text}${RESET}`;
}

export function printInfo(text: string): void {
	console.log(paint(`  ${text}`, ASH));
}

export function printSuccess(text: string): void {
	console.log(paint(`✓ ${text}`, SUCCESS, BOLD));
}

export function printWarning(text: string): void {
	console.log(paint(`⚠ ${text}`, WARNING, BOLD));
}

export function printError(text: string): void {
	console.log(paint(`✗ ${text}`, ERROR, BOLD));
}

export function printSection(title: string): void {
	console.log("");
	console.log(paint(`◆ ${title}`, ACCENT, BOLD));
}

export function printAsciiHeader(subtitleLines: string[] = []): void {
	console.log("");
	for (const line of HYPATIA_ASCII_LOGO) {
		console.log(paint(`  ${line}`, ACCENT, BOLD));
	}
	for (const line of subtitleLines) {
		console.log(paint(`  ${line}`, ASH));
	}
	console.log("");
}

export function printPanel(title: string, subtitleLines: string[] = []): void {
	const inner = 53;
	const border = "─".repeat(inner + 2);
	const renderLine = (text: string, color: string, bold = false): string => {
		const content = text.length > inner ? `${text.slice(0, inner - 3)}...` : text;
		const codes = bold ? `${color}${BOLD}` : color;
		return `${BORDER}${BOLD}│${RESET} ${codes}${content.padEnd(inner)}${RESET} ${BORDER}${BOLD}│${RESET}`;
	};

	console.log("");
	console.log(paint(`┌${border}┐`, BORDER, BOLD));
	console.log(renderLine(title, ACCENT, true));
	if (subtitleLines.length > 0) {
		console.log(paint(`├${border}┤`, BORDER, BOLD));
		for (const line of subtitleLines) {
			console.log(renderLine(line, INK));
		}
	}
	console.log(paint(`└${border}┘`, BORDER, BOLD));
	console.log("");
}
