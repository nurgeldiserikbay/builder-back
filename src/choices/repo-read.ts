// Reading the code of a branch back from the owner's repository (step 5 of the agent: a change starts from what is really in
// git, including the owner's own edits). Only text files that make sense to give to the agent are read, within limits; the
// rest stays in the repository untouched, because a push writes only the files it sends.

export const REPO_READ_LIMITS = { files: 400, bytes: 3_000_000, fileBytes: 300_000, listed: 20_000 };
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-demo', 'build', 'coverage', '.next', '.cache', '.turbo', '.npm', 'vendor']);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|avi|exe|dll|so|dylib|bin|wasm|class|pyc|db|sqlite3?|psd|ai|sketch|fig)$/i;

export interface RepoEntry { path: string; size: number | null }
export interface RepoSnapshot { files: Array<{ path: string; content: string }>; truncated: boolean; commit: string | null; branch: string }

/** Whether a listed path is worth reading: source and config, never secrets, build output or binaries. */
export function wantedPath(path: string): boolean {
  if (!path || path.length > 300 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || SKIP_DIRS.has(part))) return false;
  const name = parts.at(-1)!;
  if (/^\.env($|\.)(?!example$)/.test(name) || /^(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/.test(name) || /\.(pem|key|p12|pfx)$/i.test(name)) return false;
  return !BINARY.test(name);
}

/** The entries to read, in a stable order, and whether something was left out by the limits. */
export function chooseEntries(entries: RepoEntry[]): { chosen: RepoEntry[]; truncated: boolean } {
  const wanted = entries.filter((entry) => wantedPath(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
  const chosen: RepoEntry[] = [];
  let bytes = 0; let truncated = false;
  for (const entry of wanted) {
    if (entry.size !== null && entry.size > REPO_READ_LIMITS.fileBytes) { truncated = true; continue; }
    if (chosen.length >= REPO_READ_LIMITS.files || (entry.size !== null && bytes + entry.size > REPO_READ_LIMITS.bytes)) { truncated = true; continue; }
    bytes += entry.size ?? 0;
    chosen.push(entry);
  }
  return { chosen, truncated };
}

/** Text content only, within the limits that apply once the real size is known. */
export function acceptContent(content: string, total: number): boolean {
  return !content.includes('\0') && content.length <= REPO_READ_LIMITS.fileBytes && total + content.length <= REPO_READ_LIMITS.bytes;
}
