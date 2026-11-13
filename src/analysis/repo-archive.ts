// Downloads a repository snapshot as a ZIP for read-only analysis. Only the provider's API host is called with the
// token; GitHub's redirect is followed once, and only to its archive host, without the token. The body is read with a
// hard size cap. Nothing is cloned, checked out or executed.

export class ArchiveFetchError extends Error {
  constructor(readonly code: string) { super(code); }
}

type Fetch = typeof fetch;
export const ARCHIVE_MAX_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

async function readCapped(response: Response, max: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > max) throw new ArchiveFetchError('ARCHIVE_TOO_LARGE');
  if (!response.body) throw new ArchiveFetchError('ARCHIVE_DOWNLOAD_FAILED');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); throw new ArchiveFetchError('ARCHIVE_TOO_LARGE'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function statusCode(status: number): string {
  if (status === 401) return 'REPO_TOKEN_INVALID';
  if (status === 403) return 'REPO_ACCESS_DENIED';
  if (status === 404) return 'REPO_NOT_FOUND';
  return 'ARCHIVE_DOWNLOAD_FAILED';
}

/** Hosts GitHub may redirect an archive request to. A local test server may redirect to itself. */
function allowedRedirect(target: URL, api: URL): boolean {
  if (target.protocol === 'https:' && target.hostname === 'codeload.github.com') return true;
  return target.origin === api.origin && (api.hostname === 'localhost' || api.hostname === '127.0.0.1');
}

const refPattern = /^[A-Za-z0-9._/-]{1,200}$/;

/** An empty ref means the default branch. */
export async function fetchGithubArchive(apiUrl: string, repoPath: string, ref: string, token: string | null, fetchImpl: Fetch = fetch, max = ARCHIVE_MAX_BYTES): Promise<Buffer> {
  if (ref && (!refPattern.test(ref) || ref.includes('..'))) throw new ArchiveFetchError('REPO_REF_INVALID');
  const api = new URL(apiUrl);
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'BuildPath' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/repos/${repoPath}/zipball${ref ? `/${ref.split('/').map(encodeURIComponent).join('/')}` : ''}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch { throw new ArchiveFetchError('REPO_PROVIDER_UNAVAILABLE'); }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    let target: URL;
    try { target = new URL(location ?? '', apiUrl); } catch { throw new ArchiveFetchError('ARCHIVE_DOWNLOAD_FAILED'); }
    if (!allowedRedirect(target, api)) throw new ArchiveFetchError('ARCHIVE_REDIRECT_REFUSED');
    try {
      response = await fetchImpl(target.toString(), { headers: { 'User-Agent': 'BuildPath' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch { throw new ArchiveFetchError('REPO_PROVIDER_UNAVAILABLE'); }
  }
  if (response.status !== 200) throw new ArchiveFetchError(statusCode(response.status));
  return readCapped(response, max);
}

export async function fetchGitlabArchive(baseUrl: string, repoPath: string, ref: string, token: string, fetchImpl: Fetch = fetch, max = ARCHIVE_MAX_BYTES): Promise<Buffer> {
  if (!refPattern.test(ref) || ref.includes('..')) throw new ArchiveFetchError('REPO_REF_INVALID');
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v4/projects/${encodeURIComponent(repoPath)}/repository/archive.zip?sha=${encodeURIComponent(ref)}`, {
      headers: { 'PRIVATE-TOKEN': token, 'User-Agent': 'BuildPath' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new ArchiveFetchError('REPO_PROVIDER_UNAVAILABLE'); }
  if (response.status !== 200) throw new ArchiveFetchError(statusCode(response.status));
  return readCapped(response, max);
}
