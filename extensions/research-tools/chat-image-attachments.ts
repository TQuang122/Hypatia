import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PendingImage = { path: string };

const imageFileNamePattern = /^(?:pi-clipboard-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|orca-paste-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(?:png|jpe?g|webp|gif)$/iu;
const clipboardImagePathPattern = /(^|\s)([^\s]*[\\/](?:pi-clipboard-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|orca-paste-\d+-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(?:png|jpe?g|webp|gif))(?=$|\s)/giu;
const imageMarkerPattern = /\[Image #(\d+)\]/gu;

function isHypatiaClipboardImage(filePath: string): boolean {
	const absolutePath = resolve(filePath);
	return dirname(absolutePath) === resolve(tmpdir())
		&& imageFileNamePattern.test(basename(absolutePath));
}

async function removeTempImages(images: Iterable<PendingImage>): Promise<void> {
	await Promise.all([...images].map(async ({ path }) => {
		try { await unlink(path); } catch { /* The temp file may already be gone. */ }
	}));
}

/** Replace Pi/Orca temporary clipboard image paths with compact composer markers
 * and turn those markers back into first-class image attachments at prompt time.
 */
export function registerChatImageAttachments(pi: ExtensionAPI): (text: string) => string {
	let nextId = 1;
	let pending = new Map<number, PendingImage>();
	const clear = (): void => {
		const stale = [...pending.values()];
		pending.clear();
		nextId = 1;
		void removeTempImages(stale);
	};

	pi.on("session_start", () => { clear(); nextId = 1; });
	pi.on("session_shutdown", clear);
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || !pending.size) return;
		const submittedBatch = [...pending.entries()];
		const imageIds = [...new Set([...event.text.matchAll(imageMarkerPattern)].map((match) => Number(match[1])))];
		const selected = imageIds.map((id) => submittedBatch.find(([pendingId]) => pendingId === id)?.[1]).filter((image): image is PendingImage => image !== undefined);
		if (!selected.length) {
			clear();
			return;
		}

		try {
			const images: NonNullable<typeof event.images> = [];
			for (const image of selected) {
				const mimeType = await detectSupportedImageMimeTypeFromFile(image.path);
				if (!mimeType) throw new Error("The pasted image format is not supported.");
				const bytes = await readFile(image.path);
				images.push({ type: "image" as const, data: bytes.toString("base64"), mimeType });
			}
			for (const [id] of submittedBatch) pending.delete(id);
			if (!pending.size) nextId = 1;
			await removeTempImages(submittedBatch.map(([, image]) => image));
			return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
		} catch (error) {
			ctx.ui.notify("Could not attach pasted image. Paste it again and retry.", "error");
			if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
			return { action: "handled" };
		}
	});

	return (text: string): string => text.replace(clipboardImagePathPattern, (match, boundary: string, filePath: string) => {
		if (!isHypatiaClipboardImage(filePath)) return match;
		const id = nextId++;
		pending.set(id, { path: resolve(filePath) });
		return `${boundary}[Image #${id}]`;
	});
}
