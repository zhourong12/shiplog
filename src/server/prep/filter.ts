import type { ExcludedReason } from "../../shared/schemas.js";

const lockfiles = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "podfile.lock",
  "pubspec.lock",
  "mix.lock",
]);

const secretFilePatterns = [
  /(^|\/)\.env($|\.)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml)$/i,
];

const binaryExtensions =
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|ai|sketch|fig|mp3|mp4|mov|webm|wav|ogg|flac|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|wasm|woff2?|ttf|otf|eot|sqlite|db|bin)$/i;

const generatedPatterns = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /\.snap$/i,
  /\.pb\.(go|ts|js)$/i,
  /_generated\.\w+$/i,
  /\.generated\.\w+$/i,
  /(^|\/)__generated__\//i,
];

const vendorPatterns = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.turbo|\.cache|target)\//,
];

/** Decide whether a changed file must stay out of the AI payload and why. */
export function excludedReasonForPath(path: string, binary = false): ExcludedReason | null {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (secretFilePatterns.some((pattern) => pattern.test(normalized))) return "secret_file";
  if (lockfiles.has(base)) return "lockfile";
  if (binary || binaryExtensions.test(normalized)) return "binary";
  if (vendorPatterns.some((pattern) => pattern.test(normalized))) return "vendor";
  if (generatedPatterns.some((pattern) => pattern.test(normalized))) return "generated";
  return null;
}

export interface PatchLimits {
  maxCharsPerFile: number;
  maxCharsPerCommit: number;
  maxLineLength: number;
}

export const defaultPatchLimits: PatchLimits = {
  maxCharsPerFile: 2500,
  maxCharsPerCommit: 6000,
  maxLineLength: 400,
};

interface FilePatch {
  path: string;
  text: string;
}

/** Split a unified diff (git show / GitHub patch) into per-file sections. */
export function splitUnifiedDiff(diff: string): FilePatch[] {
  const sections: FilePatch[] = [];
  const lines = diff.split("\n");
  let current: { path: string; lines: string[] } | null = null;
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      if (current) sections.push({ path: current.path, text: current.lines.join("\n") });
      current = { path: header[2] ?? header[1] ?? "", lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push({ path: current.path, text: current.lines.join("\n") });
  return sections;
}

/**
 * Keep only the parts of a diff that are useful and safe to send to the model:
 * drop excluded files and minified lines, then cap the size per file and per commit.
 */
export function filterPatch(
  diff: string,
  limits: PatchLimits = defaultPatchLimits,
): { text: string; truncated: boolean } {
  let truncated = false;
  const kept: string[] = [];
  let used = 0;
  for (const section of splitUnifiedDiff(diff)) {
    if (excludedReasonForPath(section.path)) continue;
    if (/^Binary files /m.test(section.text)) continue;
    const lines = section.text
      .split("\n")
      .filter((line) => !line.startsWith("index ") && !line.startsWith("similarity index"))
      .map((line) => {
        if (line.length <= limits.maxLineLength) return line;
        truncated = true;
        return `${line.slice(0, limits.maxLineLength)} …[长行已截断]`;
      });
    let text = lines.join("\n");
    if (text.length > limits.maxCharsPerFile) {
      text = `${text.slice(0, limits.maxCharsPerFile)}\n…[该文件改动过长，已截断]`;
      truncated = true;
    }
    if (used + text.length > limits.maxCharsPerCommit) {
      truncated = true;
      break;
    }
    used += text.length;
    kept.push(text);
  }
  return { text: kept.join("\n"), truncated };
}
