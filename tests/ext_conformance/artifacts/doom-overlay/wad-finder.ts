import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Get the bundled WAD path (relative to this module)
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_WAD = join(__dirname, "doom1.wad");
const WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
const WAD_DOWNLOAD_TIMEOUT_MS = 20_000;

const DEFAULT_WAD_PATHS = ["./doom1.wad", "./DOOM1.WAD", "~/doom1.wad", "~/.doom/doom1.wad"];

export function findWadFile(customPath?: string): string | null {
	if (customPath) {
		const resolved = resolve(customPath.replace(/^~/, process.env.HOME || ""));
		if (existsSync(resolved)) return resolved;
		return null;
	}

	// Check bundled WAD first
	if (existsSync(BUNDLED_WAD)) {
		return BUNDLED_WAD;
	}

	// Fall back to default paths
	for (const p of DEFAULT_WAD_PATHS) {
		const resolved = resolve(p.replace(/^~/, process.env.HOME || ""));
		if (existsSync(resolved)) return resolved;
	}

	return null;
}

/** Download the shareware WAD if not present. Returns path or null on failure. */
export async function ensureWadFile(onProgress?: (message: string) => void): Promise<string | null> {
	onProgress?.("Checking for local DOOM WAD...");

	// Check if already exists
	const existing = findWadFile();
	if (existing) {
		onProgress?.(`Using DOOM WAD at ${existing}`);
		return existing;
	}

	// Download to bundled location
	try {
		onProgress?.(`Downloading DOOM WAD from ${WAD_URL}...`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("WAD download timed out")), WAD_DOWNLOAD_TIMEOUT_MS);
		const response = await fetch(WAD_URL, { signal: controller.signal });
		clearTimeout(timer);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const buffer = await response.arrayBuffer();
		writeFileSync(BUNDLED_WAD, Buffer.from(buffer));
		onProgress?.(`Downloaded DOOM WAD (${buffer.byteLength} bytes)`);
		return BUNDLED_WAD;
	} catch (error) {
		onProgress?.(`DOOM WAD download failed: ${String(error)}`);
		return null;
	}
}
