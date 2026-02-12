import { isAbsolute, relative, resolve, sep } from "node:path";

export function resolvePathWithinRoot(inputPath: string, rootDir: string): string {
	const normalizedRoot = resolve(rootDir);
	const absolutePath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(normalizedRoot, inputPath);

	if (absolutePath === normalizedRoot || absolutePath.startsWith(`${normalizedRoot}${sep}`)) {
		return absolutePath;
	}

	throw new Error(`Path "${inputPath}" resolves outside the allowed root: ${normalizedRoot}`);
}

export function toPromptPath(absolutePath: string, rootDir: string): string {
	const relativePath = relative(rootDir, absolutePath).replaceAll("\\", "/");
	return relativePath.length > 0 ? relativePath : ".";
}
