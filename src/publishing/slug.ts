// Site address rules for <slug>.<SITES_BASE_DOMAIN>.

export const reservedSlugs = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'smtp', 'static', 'assets', 'cdn', 'help', 'support', 'status', 'blog', 'docs',
  'buildpath', 'telegram', 'login', 'auth', 'billing', 'dashboard', 'preview', 'sites', 'test', 'dev', 'staging',
]);

export function slugProblem(slug: string): string | null {
  if (slug.length < 3) return 'Адрес слишком короткий — нужно от 3 символов.';
  if (slug.length > 40) return 'Адрес слишком длинный — не больше 40 символов.';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'Можно использовать только латинские буквы, цифры и дефис.';
  if (slug.startsWith('-') || slug.endsWith('-')) return 'Адрес не может начинаться или заканчиваться дефисом.';
  if (slug.includes('--')) return 'Два дефиса подряд использовать нельзя.';
  if (reservedSlugs.has(slug)) return 'Этот адрес зарезервирован. Выберите другой.';
  return null;
}

const translit: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

/** Readable address suggestion from a business name: "Торты от Айгерим" -> "torty-ot-aygerim". */
export function suggestSlug(name: string): string {
  const latin = name.toLowerCase().split('').map((char) => translit[char] ?? char).join('');
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return slug.length >= 3 && !reservedSlugs.has(slug) ? slug : `site-${slug || 'new'}`.slice(0, 40).replace(/-+$/g, '');
}

export function sitesConfig(env: NodeJS.ProcessEnv = process.env) {
  const baseDomain = (env.SITES_BASE_DOMAIN ?? 'localhost').toLowerCase().replace(/^\.+|\.+$/g, '');
  // Template for links shown to owners, e.g. https://{slug}.buildpath.site or http://{slug}.localhost:4100 in development.
  const urlTemplate = env.SITES_PUBLIC_URL_TEMPLATE ?? `http://{slug}.${baseDomain}:${env.SITES_PORT ?? 4100}`;
  return { baseDomain, urlTemplate, urlFor: (slug: string) => urlTemplate.replace('{slug}', slug) };
}

/** Maps a request Host header to a site slug; only direct subdomains of the base domain are served. */
export function slugFromHost(host: string | undefined, baseDomain: string): string | null {
  if (!host) return null;
  const hostname = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  return slug && !slug.includes('.') && slugProblem(slug) === null ? slug : null;
}
