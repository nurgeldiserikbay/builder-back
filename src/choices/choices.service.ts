import { tr } from '../i18n/i18n.js';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { JourneyService } from '../journey/journey.service.js';
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from '../reviews/url-target-policy.js';
import { choiceCards, recommend, technologiesCard, type CardKey, githubOauthSteps } from './cards.js';
import { domainTarget } from '../publishing/domain.js';
import { checkSite } from './site-check.js';
import { GITHUB_SCOPES, authorizeUrl, createRepo, exchangeCode, githubOauthConfig, githubUser, writableRepos, type GithubOauthConfig } from './github-oauth.js';
import { bookingBundle, bookingPackageFiles } from '../export/booking-package.js';
import type { SiteArtifact } from '../journey/artifacts.js';
import { GitHubClient, GitLabClient, GitProviderError, parseRepoUrl, type GitFile, type GitProviderKey } from './git-providers.js';

const isCard = (key: string): key is CardKey => key in choiceCards;

@Injectable()
export class ChoicesService {
  constructor(private readonly prisma: PrismaService, private readonly journey: JourneyService) {}

  private async access(userId: string, projectId: string, decide: boolean) {
    const access = await this.journey.projectAccess(userId, projectId);
    if (decide && !access.canDecide) throw new ForbiddenException('CHOICE_FORBIDDEN');
    if (decide && access.status === 'archived') throw new ConflictException('PROJECT_NOT_ACTIVE');
    return access;
  }

  private key(): Buffer | null {
    const raw = process.env.CODE_HOSTING_TOKEN_ENCRYPTION_KEY;
    if (!raw) return null;
    const key = Buffer.from(raw, 'base64');
    return key.length === 32 ? key : null;
  }

  private encrypt(token: string, key: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
  }

  private decrypt(payload: string, key: Buffer): string {
    const [iv, tag, data] = payload.split('.');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('REPO_RECONNECT_REQUIRED');
    }
  }

  private allowLocal(): boolean {
    return process.env.CODE_HOSTING_ALLOW_LOCAL === 'true' && process.env.NODE_ENV !== 'production';
  }

  private client(provider: GitProviderKey, token: string, baseUrl: string) {
    if (provider === 'github') {
      const api = baseUrl === 'https://github.com' ? (process.env.GITHUB_API_URL ?? 'https://api.github.com') : `${baseUrl}/api/v3`;
      return new GitHubClient(token, api.replace(/\/$/, ''));
    }
    return new GitLabClient(token, baseUrl);
  }

  private repositoryView(repo: { provider: string; connectedVia: string; repoPath: string; webUrl: string; defaultBranch: string; isPrivate: boolean; tokenHint: string; verifiedAt: Date; lastPushAt: Date | null; lastCommitUrl: string | null; lastError: string | null } | null) {
    return repo ? {
      provider: repo.provider, connectedVia: repo.connectedVia, repoPath: repo.repoPath, webUrl: repo.webUrl, defaultBranch: repo.defaultBranch, isPrivate: repo.isPrivate,
      tokenHint: `…${repo.tokenHint}`, verifiedAt: repo.verifiedAt, lastPushAt: repo.lastPushAt, lastCommitUrl: repo.lastCommitUrl, lastError: repo.lastError,
    } : null;
  }

  async card(userId: string, projectId: string, cardKey: string) {
    if (!isCard(cardKey)) throw new NotFoundException('CHOICE_CARD_NOT_FOUND');
    const access = await this.access(userId, projectId, false);
    const [choice, repo] = await Promise.all([
      this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey } } }),
      cardKey === 'code_hosting' ? this.prisma.codeRepository.findUnique({ where: { projectId } }) : null,
    ]);
    const met = await this.requirementsMet(projectId, cardKey);
    return {
      data: {
        card: cardKey === 'code_hosting' && githubOauthConfig() && this.key()
          ? { ...choiceCards[cardKey], options: choiceCards[cardKey].options.map((option) => (option.key === 'github' ? { ...option, steps: githubOauthSteps } : option)) }
          : cardKey === 'technologies' ? technologiesCard(access.projectType) : choiceCards[cardKey],
        recommendation: recommend(cardKey, access),
        choice: choice ? { optionKey: choice.optionKey, reason: choice.reason, stepsDone: choice.stepsDone, chosenAt: choice.chosenAt, cardVersion: choice.cardVersion, verification: choice.verification ?? null } : null,
        available: met,
        context: cardKey === 'deployment' ? await this.deploymentContext(projectId) : cardKey === 'domain' ? await this.domainContext(projectId) : null,
        repository: this.repositoryView(repo),
        canDecide: access.canDecide,
        connectAvailable: Boolean(this.key()),
      },
    };
  }

  async choose(userId: string, projectId: string, cardKey: string, optionKey: string, reason: string | null) {
    if (!isCard(cardKey)) throw new NotFoundException('CHOICE_CARD_NOT_FOUND');
    await this.access(userId, projectId, true);
    const card = choiceCards[cardKey];
    if (!card.options.some((option) => option.key === optionKey)) throw new BadRequestException('CHOICE_OPTION_INVALID');
    if ((await this.requirementsMet(projectId, cardKey))[optionKey] === false) throw new ConflictException('CHOICE_REQUIREMENT_NOT_MET');
    const previous = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey } }, select: { optionKey: true } });
    await this.prisma.$transaction([
      this.prisma.projectChoice.upsert({
        where: { projectId_cardKey: { projectId, cardKey } },
        create: { projectId, cardKey, cardVersion: card.version, optionKey, reason, chosenByUserId: userId },
        update: { cardVersion: card.version, optionKey, reason, chosenByUserId: userId, chosenAt: new Date(), ...(previous?.optionKey !== optionKey ? { stepsDone: [], verification: Prisma.DbNull } : {}) },
      }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'choice_made', details: { cardKey, optionKey, previous: previous?.optionKey ?? null } } }),
    ]);
    return this.card(userId, projectId, cardKey);
  }

  async markStep(userId: string, projectId: string, cardKey: string, stepKey: string, done: boolean) {
    if (!isCard(cardKey)) throw new NotFoundException('CHOICE_CARD_NOT_FOUND');
    await this.access(userId, projectId, true);
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey } } });
    if (!choice) throw new ConflictException('CHOICE_NOT_MADE');
    const step = choiceCards[cardKey].options.find((option) => option.key === choice.optionKey)?.steps.find((item) => item.key === stepKey);
    // Steps that BuildPath checks itself cannot be ticked off by hand.
    if (!step || step.kind === 'connect' || step.kind === 'verify' || step.kind === 'domain') throw new BadRequestException('CHOICE_STEP_INVALID');
    const steps = new Set(choice.stepsDone);
    if (done) steps.add(stepKey); else steps.delete(stepKey);
    await this.prisma.projectChoice.update({ where: { id: choice.id }, data: { stepsDone: [...steps] } });
    return this.card(userId, projectId, cardKey);
  }

  /** Checks the address and key against the provider and stores the connection only when writing is allowed. */
  async connect(userId: string, projectId: string, input: { provider: GitProviderKey; repoUrl: string; token: string }) {
    await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } }, select: { optionKey: true } });
    if (choice?.optionKey !== input.provider) throw new ConflictException('CHOICE_NOT_MADE');
    const token = input.token.trim();
    if (token.length < 20 || token.length > 400 || /\s/.test(token)) throw new BadRequestException('REPO_TOKEN_INVALID');
    let parsed: { baseUrl: string; repoPath: string };
    try {
      parsed = parseRepoUrl(input.provider, input.repoUrl, this.allowLocal());
      // Own GitLab servers: refuse private and internal addresses.
      if (!this.allowLocal() && parsed.baseUrl !== 'https://github.com' && parsed.baseUrl !== 'https://gitlab.com') await resolveAndValidateReviewTarget(`${parsed.baseUrl}/`);
    } catch (error) {
      if (error instanceof GitProviderError) throw new BadRequestException(error.code);
      if (error instanceof ReviewTargetPolicyError) throw new BadRequestException('REPO_HOST_NOT_ALLOWED');
      throw error;
    }
    return this.storeRepository(userId, projectId, input.provider, parsed, token, key, 'token');
  }

  /** Checks write access with the token and saves the connection; the token is stored only encrypted. */
  private async storeRepository(userId: string, projectId: string, provider: GitProviderKey, parsed: { baseUrl: string; repoPath: string }, token: string, key: Buffer, via: 'token' | 'oauth') {
    let info;
    try {
      info = await this.client(provider, token, parsed.baseUrl).inspect(parsed.repoPath);
    } catch (error) {
      if (error instanceof GitProviderError) throw new UnprocessableEntityException(error.code);
      throw error;
    }
    if (!info.canWrite) throw new UnprocessableEntityException('REPO_WRITE_NOT_ALLOWED');
    const data = {
      provider, baseUrl: parsed.baseUrl, repoPath: info.repoPath, webUrl: info.webUrl, defaultBranch: info.defaultBranch, isPrivate: info.isPrivate,
      tokenEncrypted: this.encrypt(token, key), tokenHint: token.slice(-4), connectedVia: via, connectedByUserId: userId, verifiedAt: new Date(), lastError: null,
    };
    const steps = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } }, select: { stepsDone: true } });
    await this.prisma.$transaction([
      this.prisma.codeRepository.upsert({ where: { projectId }, create: { projectId, ...data }, update: data }),
      this.prisma.projectChoice.update({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } }, data: { stepsDone: [...new Set([...(steps?.stepsDone ?? []), 'connect'])] } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_connected', details: { provider, repoPath: info.repoPath, isPrivate: info.isPrivate, via } } }),
    ]);
    return this.card(userId, projectId, 'code_hosting');
  }

  // --- GitHub with one tap (OAuth App) ---

  private githubAccount(userId: string) {
    return this.prisma.gitAccount.findUnique({ where: { userId_provider: { userId, provider: 'github' } }, select: { login: true, tokenEncrypted: true, tokenHint: true, createdAt: true } });
  }

  private async githubToken(userId: string): Promise<{ config: GithubOauthConfig; key: Buffer; token: string; login: string }> {
    const config = githubOauthConfig();
    const key = this.key();
    if (!config || !key) throw new ServiceUnavailableException('GITHUB_OAUTH_NOT_CONFIGURED');
    const account = await this.githubAccount(userId);
    if (!account) throw new ConflictException('GITHUB_NOT_CONNECTED');
    return { config, key, token: this.decrypt(account.tokenEncrypted, key), login: account.login };
  }

  /** Step 1: the address of GitHub's consent page. The state is single-use, bound to the person and project, 10 minutes. */
  async githubStart(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const config = githubOauthConfig();
    if (!config || !this.key()) throw new ServiceUnavailableException('GITHUB_OAUTH_NOT_CONFIGURED');
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } }, select: { optionKey: true } });
    if (choice?.optionKey !== 'github') throw new ConflictException('CHOICE_NOT_MADE');
    const state = randomBytes(24).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.oAuthState.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { userId, provider: 'github' }] } }),
      this.prisma.oAuthState.create({ data: { stateHash: sha256(state), userId, projectId, provider: 'github', expiresAt: new Date(Date.now() + 10 * 60_000) } }),
    ]);
    return { data: { url: authorizeUrl(config, state), scopes: GITHUB_SCOPES } };
  }

  /**
   * Step 2, GitHub redirects back here. Works without the session cookie: the state carries who started it, and
   * a state can only be created by that person. Returns where to send the browser.
   */
  async githubCallback(query: { code?: string; state?: string; error?: string }): Promise<string> {
    const app = (process.env.PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const config = githubOauthConfig();
    const key = this.key();
    const stateValue = typeof query.state === 'string' && /^[A-Za-z0-9_-]{32}$/.test(query.state) ? query.state : null;
    const row = stateValue ? await this.prisma.oAuthState.findUnique({ where: { stateHash: sha256(stateValue) } }) : null;
    if (row) await this.prisma.oAuthState.delete({ where: { id: row.id } });
    if (!row || row.expiresAt < new Date()) return `${app}/projects?github=expired`;
    const back = (result: string) => `${app}/projects/${row.projectId}/choices/code_hosting?github=${result}`;
    if (query.error) return back(query.error === 'access_denied' ? 'denied' : 'failed');
    if (!config || !key || typeof query.code !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(query.code)) return back('failed');
    try {
      const token = await exchangeCode(config, query.code);
      const user = await githubUser(config, token);
      const data = { login: user.login, tokenEncrypted: this.encrypt(token, key), tokenHint: token.slice(-4), scopes: user.scopes.slice(0, 200) };
      await this.prisma.$transaction([
        this.prisma.gitAccount.upsert({ where: { userId_provider: { userId: row.userId, provider: 'github' } }, create: { userId: row.userId, provider: 'github', ...data }, update: data }),
        this.prisma.projectEvent.create({ data: { projectId: row.projectId, actorUserId: row.userId, type: 'github_account_connected', details: { login: user.login } } }),
      ]);
      return back('connected');
    } catch {
      return back('failed');
    }
  }

  /** The person's GitHub account and the repositories they can write to. */
  async githubRepos(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const config = githubOauthConfig();
    if (!config || !this.key()) return { data: { configured: false, account: null, repos: [] } };
    const account = await this.githubAccount(userId);
    if (!account) return { data: { configured: true, account: null, repos: [] } };
    try {
      const { token, login } = await this.githubToken(userId);
      return { data: { configured: true, account: { login, connectedAt: account.createdAt }, repos: await writableRepos(config, token) } };
    } catch (error) {
      if (error instanceof GitProviderError && error.code === 'GITHUB_RECONNECT_REQUIRED') {
        await this.prisma.gitAccount.delete({ where: { userId_provider: { userId, provider: 'github' } } }).catch(() => undefined);
        return { data: { configured: true, account: null, repos: [], reconnect: true } };
      }
      if (error instanceof GitProviderError) throw new UnprocessableEntityException(error.code);
      throw error;
    }
  }

  /** Step 3: connect an existing repository, or create a new empty one in the person's account (explicit confirmation). */
  async githubConnect(userId: string, projectId: string, input: { repo: string | null; create: { name: string; isPrivate: boolean } | null; confirm: boolean }) {
    const access = await this.access(userId, projectId, true);
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } }, select: { optionKey: true } });
    if (choice?.optionKey !== 'github') throw new ConflictException('CHOICE_NOT_MADE');
    const { config, key, token } = await this.githubToken(userId);
    let fullName: string;
    if (input.create) {
      if (!input.confirm) throw new BadRequestException('CONFIRMATION_REQUIRED');
      try {
        fullName = (await createRepo(config, token, { name: input.create.name, isPrivate: input.create.isPrivate, description: tr("Сайт «{0}», собранный в BuildPath", [access.name]) })).fullName;
      } catch (error) {
        if (error instanceof GitProviderError) throw error.code === 'REPO_NAME_TAKEN' ? new ConflictException(error.code) : new UnprocessableEntityException(error.code);
        throw error;
      }
      await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_created', details: { repoPath: fullName, isPrivate: input.create.isPrivate } } });
    } else {
      if (!input.repo || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repo)) throw new BadRequestException('REPO_URL_INVALID');
      fullName = input.repo;
    }
    return this.storeRepository(userId, projectId, 'github', { baseUrl: 'https://github.com', repoPath: fullName }, token, key, 'oauth');
  }

  /** Forget the GitHub account in BuildPath. Repositories already connected keep working until disconnected. */
  async githubForget(userId: string) {
    await this.prisma.gitAccount.deleteMany({ where: { userId, provider: 'github' } });
    return { data: { forgotten: true, revokeUrl: 'https://github.com/settings/applications' } };
  }

  async disconnect(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId }, select: { repoPath: true } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    await this.prisma.$transaction([
      this.prisma.codeRepository.delete({ where: { projectId } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_disconnected', details: { repoPath: repo.repoPath } } }),
    ]);
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } } });
    if (choice) await this.prisma.projectChoice.update({ where: { id: choice.id }, data: { stepsDone: choice.stepsDone.filter((item) => item !== 'connect') } });
    return this.card(userId, projectId, 'code_hosting');
  }

  /** Files that a push would send: only accepted results, the same as the downloadable package. */
  private async files(userId: string, projectId: string): Promise<{ files: GitFile[]; siteIncluded: boolean; complete: boolean }> {
    const result = (await this.journey.result(userId, projectId)).data as { complete: boolean; files: Array<{ name: string; content: string }> };
    const pick = (name: string) => result.files.find((file) => file.name === name)?.content;
    const files: GitFile[] = [];
    const site = pick('site.html');
    if (site) files.push({ path: 'index.html', content: site });
    const md = pick('project.md'); if (md) files.push({ path: 'project.md', content: md });
    const json = pick('project.json'); if (json) files.push({ path: 'project.json', content: json });
    files.push({ path: 'README.md', content: [
      '# Сайт, созданный в BuildPath', '',
      site ? '- `index.html` — готовая страница сайта. Её можно открыть в браузере или загрузить на любой хостинг статических сайтов.' : '- Сайт ещё не собран: здесь только описание проекта.',
      '- `project.md` — паспорт проекта и все тексты.', '- `project.json` — все данные проекта для разработчика или переноса.', '',
      'Файлы обновляются из BuildPath по кнопке «Отправить в репозиторий». Ручные изменения в этих файлах будут заменены при следующей отправке.', '',
    ].join('\n') });
    return { files, siteIncluded: Boolean(site), complete: result.complete };
  }

  async pushPreview(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    const { files, siteIncluded, complete } = await this.files(userId, projectId);
    return { data: { repository: this.repositoryView(repo), branch: repo.defaultBranch, files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) })), siteIncluded, complete } };
  }

  /** Sends accepted results to the connected repository. Requires explicit confirmation every time. */
  async push(userId: string, projectId: string, confirm: boolean) {
    if (!confirm) throw new BadRequestException('CONFIRMATION_REQUIRED');
    const access = await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    const { files } = await this.files(userId, projectId);
    const token = this.decrypt(repo.tokenEncrypted, key);
    try {
      const { commitUrl } = await this.client(repo.provider as GitProviderKey, token, repo.baseUrl).commit(repo.repoPath, repo.defaultBranch, files, tr("BuildPath: {0} — принятая версия", [access.name]));
      await this.prisma.$transaction([
        this.prisma.codeRepository.update({ where: { projectId }, data: { lastPushAt: new Date(), lastCommitUrl: commitUrl || null, lastError: null } }),
        this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_pushed', details: { repoPath: repo.repoPath, files: files.map((file) => file.path), commitUrl } } }),
      ]);
    } catch (error) {
      const code = error instanceof GitProviderError ? error.code : 'REPO_PROVIDER_FAILED';
      await this.prisma.codeRepository.update({ where: { projectId }, data: { lastError: code } });
      throw new UnprocessableEntityException(code);
    }
    return this.card(userId, projectId, 'code_hosting');
  }

  /** Options that depend on another decision: available only when that decision is made (and, for GitHub, connected). */
  private async requirementsMet(projectId: string, cardKey: CardKey): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const option of choiceCards[cardKey].options) {
      if (!option.requires) continue;
      const other = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: option.requires.card } }, select: { optionKey: true } });
      const repo = option.requires.card === 'code_hosting' ? await this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true } }) : null;
      result[option.key] = other?.optionKey === option.requires.option && (option.requires.card !== 'code_hosting' || repo?.provider === option.requires.option);
    }
    return result;
  }

  private async acceptedBuildId(projectId: string): Promise<string | null> {
    const stage = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey: 'build' }, select: { approvedVersionId: true, status: true } });
    return stage?.approvedVersionId ?? null;
  }

  private async deploymentContext(projectId: string) {
    const [publication, buildId, repo] = await Promise.all([
      this.prisma.sitePublication.findUnique({ where: { projectId }, select: { status: true, slug: true, buildVersionId: true } }),
      this.acceptedBuildId(projectId),
      this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true, repoPath: true, lastPushAt: true } }),
    ]);
    return {
      siteAccepted: Boolean(buildId),
      publication: publication ? { status: publication.status, slug: publication.slug, upToDate: publication.buildVersionId === buildId } : null,
      repository: repo ? { provider: repo.provider, repoPath: repo.repoPath, pushedAt: repo.lastPushAt } : null,
    };
  }

  /** Where the owner's domain stands; the domain step is done once DNS points at BuildPath. */
  private async domainContext(projectId: string) {
    const [publication, buildId] = await Promise.all([
      this.prisma.sitePublication.findUnique({ where: { projectId }, select: { status: true, slug: true, customDomain: true, domainStatus: true, buildVersionId: true } }),
      this.acceptedBuildId(projectId),
    ]);
    const target = domainTarget();
    return {
      domainsAvailable: Boolean(target),
      kzAllowed: Boolean(target?.hostedInKz),
      publication: publication ? { status: publication.status, slug: publication.slug, upToDate: publication.buildVersionId === buildId, domain: publication.customDomain, domainStatus: publication.domainStatus } : null,
    };
  }

  /** Checks that the chosen deployment serves the latest accepted version of the site. */
  async verifyDeployment(userId: string, projectId: string, url: string | null) {
    await this.access(userId, projectId, true);
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'deployment' } } });
    if (!choice) throw new ConflictException('CHOICE_NOT_MADE');
    const result = (await this.journey.result(userId, projectId)).data as { files: Array<{ name: string; content: string }> };
    const expected = result.files.find((file) => file.name === 'site.html')?.content;
    if (!expected) throw new ConflictException('SITE_NOT_ACCEPTED');
    let verification: { url: string | null; status: string; checkedAt: string; httpStatus: number | null };
    if (choice.optionKey === 'buildpath') {
      const context = await this.deploymentContext(projectId);
      const status = !context.publication || context.publication.status !== 'live' ? 'not_published' : context.publication.upToDate ? 'matches' : 'outdated';
      verification = { url: null, status, checkedAt: new Date().toISOString(), httpStatus: null };
    } else {
      if (!url) throw new BadRequestException('SITE_URL_REQUIRED');
      const checked = await checkSite(url, expected, { allowLocal: this.allowLocal() });
      verification = { url: checked.finalUrl ?? url, status: checked.status, checkedAt: new Date().toISOString(), httpStatus: checked.httpStatus };
    }
    const steps = new Set(choice.stepsDone);
    if (verification.status === 'matches') steps.add('verify'); else steps.delete('verify');
    await this.prisma.$transaction([
      this.prisma.projectChoice.update({ where: { id: choice.id }, data: { verification, stepsDone: [...steps] } }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'deployment_checked', details: { option: choice.optionKey, status: verification.status, url: verification.url } } }),
    ]);
    return this.card(userId, projectId, 'deployment');
  }

  /** Files for an own server: the accepted page, a Caddy config with automatic HTTPS, a compose file and plain instructions. */
  async serverPackage(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const result = (await this.journey.result(userId, projectId)).data as { files: Array<{ name: string; content: string }> };
    const site = result.files.find((file) => file.name === 'site.html')?.content;
    if (!site) throw new ConflictException('SITE_NOT_ACCEPTED');
    const build = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey: 'build' }, select: { approvedVersionId: true } });
    const artifact = build?.approvedVersionId ? (await this.prisma.stageArtifactVersion.findUnique({ where: { id: build.approvedVersionId }, select: { content: true } }))?.content as unknown as SiteArtifact | undefined : undefined;
    if (artifact?.meta?.booking) {
      // Online booking needs a program on the server, not just a page: ship the bundled booking app with the accepted schedule.
      let bundle: string;
      try { bundle = await bookingBundle(); } catch { throw new ServiceUnavailableException('EXPORT_NOT_BUILT'); }
      return { data: { folder: 'buildpath-site', kind: 'booking_app', files: bookingPackageFiles(artifact, bundle) } };
    }
    const caddy = ['# Замените ВАШ-ДОМЕН.kz на свой домен. Caddy сам получит HTTPS-сертификат.', 'ВАШ-ДОМЕН.kz {', '\troot * /srv', '\tfile_server', '\tencode gzip', '\theader {', '\t\tX-Content-Type-Options nosniff', '\t\tReferrer-Policy strict-origin-when-cross-origin', '\t}', '}', ''].join('\n');
    const compose = ['services:', '  site:', '    image: caddy:2', '    restart: unless-stopped', '    ports: ["80:80", "443:443"]', '    volumes:', '      - ./Caddyfile:/etc/caddy/Caddyfile:ro', '      - ./site:/srv:ro', '      - caddy_data:/data', 'volumes:', '  caddy_data: {}', ''].join('\n');
    const readme = [
      '# Как запустить сайт на своём сервере', '',
      'Нужно: сервер с Ubuntu 24.04 и домен, направленный на IP сервера (запись A).', '',
      '1. В файле `Caddyfile` замените `ВАШ-ДОМЕН.kz` на свой домен.',
      '2. Скопируйте папку с файлами на сервер, например так (на своём компьютере): `scp -r buildpath-site root@IP-СЕРВЕРА:/opt/`',
      '3. Подключитесь к серверу: `ssh root@IP-СЕРВЕРА` и выполните:', '',
      '```', 'curl -fsSL https://get.docker.com | sh', 'cd /opt/buildpath-site', 'docker compose up -d', '```', '',
      '4. Через минуту откройте свой домен в браузере. Вернитесь в BuildPath и нажмите «Проверить адрес».', '',
      'Обновить сайт: замените `site/index.html` новой версией из BuildPath — перезапускать ничего не нужно.', '',
      'Форма заявок BuildPath на своём сервере не работает: на сайте останутся кнопки звонка и мессенджера.', '',
    ].join('\n');
    return {
      data: {
        folder: 'buildpath-site', kind: 'static',
        files: [
          { name: 'site/index.html', mimeType: 'text/html', content: site },
          { name: 'Caddyfile', mimeType: 'text/plain', content: caddy },
          { name: 'compose.yaml', mimeType: 'text/yaml', content: compose },
          { name: 'README.md', mimeType: 'text/markdown', content: readme },
        ],
      },
    };
  }
}
