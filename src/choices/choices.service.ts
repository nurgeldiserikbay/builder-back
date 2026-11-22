import type { RepoSnapshot } from './repo-read.js';
import { contentLocale, runWithLocale, tr } from '../i18n/i18n.js';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { decryptToken, encryptToken, tokenKey } from '../security/token-crypto.js';
import { HOSTING_PROVIDERS, HostingError, hostingProvider, hostingProviderName, type HostingProviderKey } from './hosting-providers.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { JourneyService } from '../journey/journey.service.js';
import { ReviewTargetPolicyError, resolveAndValidateReviewTarget } from '../reviews/url-target-policy.js';
import { choiceCards, codeHostingCard, recommend, technologiesCard, type CardKey, githubOauthSteps } from './cards.js';
import { domainTarget } from '../publishing/domain.js';
import { sitesConfig } from '../publishing/slug.js';
import { checkSite } from './site-check.js';
import { GITHUB_SCOPES, authorizeUrl, createRepo, exchangeCode, githubOauthConfig, githubUser, writableRepos, type GithubOauthConfig } from './github-oauth.js';
import { bookingBundle, bookingPackageFiles } from '../export/booking-package.js';
import type { SiteArtifact } from '../journey/artifacts.js';
import { BitbucketClient, GitHubClient, GiteaClient, GitLabClient, GitProviderError, gitProviderName, parseRepoUrl, type ApiGitProviderKey, type GitFile, type GitProviderKey } from './git-providers.js';
import { BOOKING_APP_DIR, ciDeployFile, renderBlueprint, staticDockerfile } from './infra-files.js';
import { generateDeployKey, parseSshUrl, scanHostKeys, sshDisplayUrl, SshGitClient, sshToolsAvailable, type SshRemote } from './ssh-git.js';

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
    return tokenKey();
  }

  private encrypt(token: string, key: Buffer): string {
    return encryptToken(token, key);
  }

  private decrypt(payload: string, key: Buffer): string {
    const token = decryptToken(payload, key);
    if (token === null) throw new ServiceUnavailableException('REPO_RECONNECT_REQUIRED');
    return token;
  }

  private allowLocal(): boolean {
    return process.env.CODE_HOSTING_ALLOW_LOCAL === 'true' && process.env.NODE_ENV !== 'production';
  }

  private client(provider: ApiGitProviderKey, token: string, baseUrl: string) {
    if (provider === 'github') {
      const api = baseUrl === 'https://github.com' ? (process.env.GITHUB_API_URL ?? 'https://api.github.com') : `${baseUrl}/api/v3`;
      return new GitHubClient(token, api.replace(/\/$/, ''));
    }
    if (provider === 'gitea') return new GiteaClient(token, baseUrl);
    if (provider === 'bitbucket') {
      const api = baseUrl === 'https://bitbucket.org' ? (process.env.BITBUCKET_API_URL ?? 'https://api.bitbucket.org/2.0') : `${baseUrl}/2.0`;
      return new BitbucketClient(token, api.replace(/\/$/, ''));
    }
    return new GitLabClient(token, baseUrl);
  }

  private repositoryView(repo: { provider: string; connectedVia: string; repoPath: string; webUrl: string; defaultBranch: string; isPrivate: boolean; tokenHint: string; verifiedAt: Date; lastPushAt: Date | null; lastCommitUrl: string | null; lastError: string | null } | null) {
    return repo ? {
      provider: repo.provider, connectedVia: repo.connectedVia, repoPath: repo.repoPath, webUrl: repo.webUrl, defaultBranch: repo.defaultBranch, isPrivate: repo.isPrivate,
      tokenHint: `…${repo.tokenHint}`, verifiedAt: repo.verifiedAt, lastPushAt: repo.lastPushAt, lastCommitUrl: repo.lastCommitUrl, lastError: repo.lastError,
    } : null;
  }

  /**
   * «Уже решено за вас»: every decision of the project as it stands — the owner's choice or, until they make one, the
   * platform's default (the recommendation) — with what it means right now and the other options behind «Изменить».
   * A newcomer never has to decide; someone who knows can change any of it. A web application is not published here,
   * so it has only the code decision.
   */
  async summary(userId: string, projectId: string) {
    const access = await this.access(userId, projectId, false);
    const cards: CardKey[] = access.projectType === 'web_app' ? ['code_hosting'] : ['technologies', 'deployment', 'domain', 'code_hosting'];
    const [choices, repo, publication, hosting] = await Promise.all([
      this.prisma.projectChoice.findMany({ where: { projectId }, select: { cardKey: true, optionKey: true, chosenAt: true } }),
      this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true, repoPath: true, webUrl: true } }),
      this.prisma.sitePublication.findUnique({ where: { projectId }, select: { status: true, slug: true, customDomain: true, domainStatus: true } }),
      this.prisma.hostingConnection.findUnique({ where: { projectId }, select: { provider: true, siteUrl: true } }),
    ]);
    const live = publication?.status === 'live';
    const items = cards.map((key) => {
      const card = key === 'technologies' ? technologiesCard(access.projectType) : key === 'code_hosting' ? codeHostingCard(access.projectType) : choiceCards[key];
      const choice = choices.find((item) => item.cardKey === key);
      const recommendation = recommend(key, access);
      const optionKey = choice?.optionKey ?? recommendation.optionKey;
      const option = card.options.find((item) => item.key === optionKey) ?? card.options[0]!;
      return {
        cardKey: key, title: card.title, optionKey: option.key, optionTitle: option.title,
        decidedBy: choice ? 'owner' as const : 'default' as const,
        // What the decision means for this project right now, in one sentence.
        now: this.decisionNow(key, option.key, { live, slug: publication?.slug ?? null, domain: publication?.customDomain && publication.domainStatus === 'active' ? publication.customDomain : null, repo, hosting }),
        why: choice ? null : recommendation.reason,
        others: card.options.filter((item) => item.key !== option.key).map((item) => ({ key: item.key, title: item.title, summary: item.summary })),
      };
    });
    return { data: { items, canDecide: access.canDecide } };
  }

  private decisionNow(card: CardKey, option: string, state: { live: boolean; slug: string | null; domain: string | null; repo: { provider: string; repoPath: string; webUrl: string } | null; hosting: { provider: string; siteUrl: string | null } | null }): string {
    if (card === 'technologies') return option === 'buildpath' ? tr('Сайт собирает и проверяет BuildPath; файлы ваши, их можно скачать в любой момент.') : option === 'developer' ? tr('Сайт делает разработчик на своём стеке; BuildPath готовит для него тексты, схемы и ТЗ.') : tr('Сайт собираете в конструкторе сами, перенося тексты; BuildPath готовит материалы.');
    if (card === 'deployment') {
      if (option === 'buildpath') return state.live ? tr('Сайт работает на BuildPath.') : tr('После публикации сайт будет работать на BuildPath — одной кнопкой на вкладке «Публикация».');
      if (state.hosting?.siteUrl) return tr('Сайт выкладывается на {0}: {1}.', [hostingProviderName[state.hosting.provider] ?? state.hosting.provider, state.hosting.siteUrl]);
      return tr('Сайт будет работать у вас — пошаговая инструкция в «Изменить».');
    }
    if (card === 'domain') {
      if (state.domain) return tr('Сайт открывается по вашему адресу {0}.', [state.domain]);
      if (option === 'own_domain') return tr('Свой домен ещё не подключён — шаги в «Изменить».');
      return state.live && state.slug ? tr('Адрес сайта: {0}.', [sitesConfig().urlFor(state.slug)]) : tr('Бесплатный адрес BuildPath выберете при публикации; свой домен можно подключить позже.');
    }
    if (state.repo) return tr('Код в репозитории {0}: {1}.', [gitProviderName[state.repo.provider as GitProviderKey] ?? state.repo.provider, state.repo.webUrl]);
    if (option === 'archive') return tr('Копию всех файлов можно скачать архивом на вкладке «Результат» — на случай переезда или для разработчика.');
    return tr('Репозиторий ещё не подключён — шаги в «Изменить».');
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
          ? { ...codeHostingCard(access.projectType), options: choiceCards[cardKey].options.map((option) => (option.key === 'github' ? { ...option, steps: githubOauthSteps } : option)) }
          : cardKey === 'technologies' ? technologiesCard(access.projectType) : cardKey === 'code_hosting' ? codeHostingCard(access.projectType) : choiceCards[cardKey],
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
    if (!step || step.kind === 'connect' || step.kind === 'verify' || step.kind === 'domain' || step.kind === 'hosting_connect' || step.kind === 'hosting_deploy') throw new BadRequestException('CHOICE_STEP_INVALID');
    const steps = new Set(choice.stepsDone);
    if (done) steps.add(stepKey); else steps.delete(stepKey);
    await this.prisma.projectChoice.update({ where: { id: choice.id }, data: { stepsDone: [...steps] } });
    return this.card(userId, projectId, cardKey);
  }

  /** Checks the address and key against the provider and stores the connection only when writing is allowed. */
  async connect(userId: string, projectId: string, input: { provider: GitProviderKey; repoUrl: string; token: string; branch?: string | null; hostFingerprint?: string | null }) {
    await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } }, select: { optionKey: true } });
    if (choice?.optionKey !== input.provider) throw new ConflictException('CHOICE_NOT_MADE');
    if (input.provider === 'ssh') return this.connectSsh(userId, projectId, { repoUrl: input.repoUrl, branch: input.branch ?? null, hostFingerprint: input.hostFingerprint ?? null }, key);
    const token = input.token.trim();
    if (token.length < 20 || token.length > 400 || /\s/.test(token)) throw new BadRequestException('REPO_TOKEN_INVALID');
    let parsed: { baseUrl: string; repoPath: string };
    try {
      parsed = parseRepoUrl(input.provider, input.repoUrl, this.allowLocal());
      // Own GitLab servers: refuse private and internal addresses.
      if (!this.allowLocal() && !['https://github.com', 'https://gitlab.com', 'https://bitbucket.org', 'https://codeberg.org'].includes(parsed.baseUrl)) await resolveAndValidateReviewTarget(`${parsed.baseUrl}/`);
    } catch (error) {
      if (error instanceof GitProviderError) throw new BadRequestException(error.code);
      if (error instanceof ReviewTargetPolicyError) throw new BadRequestException('REPO_HOST_NOT_ALLOWED');
      throw error;
    }
    return this.storeRepository(userId, projectId, input.provider, parsed, token, key, 'token');
  }

  /** Checks write access with the token and saves the connection; the token is stored only encrypted. */
  private async storeRepository(userId: string, projectId: string, provider: ApiGitProviderKey, parsed: { baseUrl: string; repoPath: string }, token: string, key: Buffer, via: 'token' | 'oauth') {
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

  /** Resolves the server name and refuses private and internal addresses; returns the checked IP git will connect to. */
  private async sshAddress(remote: SshRemote): Promise<string> {
    if (this.allowLocal() && (remote.host === 'localhost' || remote.host === '127.0.0.1')) return '127.0.0.1';
    try {
      const checked = await resolveAndValidateReviewTarget(`https://${remote.host.includes(':') ? `[${remote.host}]` : remote.host}/`);
      return checked.resolvedAddresses[0];
    } catch (error) {
      if (error instanceof ReviewTargetPolicyError) throw new BadRequestException('REPO_HOST_NOT_ALLOWED');
      throw error;
    }
  }

  private async sshReady() {
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    if (!(await sshToolsAvailable())) throw new ServiceUnavailableException('SSH_GIT_NOT_AVAILABLE');
    return key;
  }

  private sshKeyView(row: { publicKey: string; fingerprint: string; createdAt: Date } | null) {
    return row ? { publicKey: row.publicKey, fingerprint: row.fingerprint, createdAt: row.createdAt } : null;
  }

  async sshKey(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const row = await this.prisma.sshDeployKey.findUnique({ where: { projectId } });
    return { data: { key: this.sshKeyView(row), available: Boolean(this.key()) && await sshToolsAvailable() } };
  }

  /**
   * The project's deploy key: created once and kept when the repository is disconnected, so the owner does not have to add it
   * again. A new key (rotate) disconnects the repository — the old key stops working here at once.
   */
  async createSshKey(userId: string, projectId: string, rotate: boolean) {
    const access = await this.access(userId, projectId, true);
    const key = await this.sshReady();
    const existing = await this.prisma.sshDeployKey.findUnique({ where: { projectId } });
    if (existing && !rotate) return { data: { key: this.sshKeyView(existing), available: true } };
    let generated;
    try { generated = await generateDeployKey(`buildpath-${projectId.slice(0, 8)}`); } catch { throw new ServiceUnavailableException('SSH_GIT_NOT_AVAILABLE'); }
    const data = { publicKey: generated.publicKey.slice(0, 200), fingerprint: generated.fingerprint.slice(0, 80), privateKeyEncrypted: this.encrypt(generated.privateKey, key), createdByUserId: userId };
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true } });
    await this.prisma.$transaction([
      this.prisma.sshDeployKey.upsert({ where: { projectId }, create: { projectId, ...data }, update: { ...data, createdAt: new Date() } }),
      ...(repo?.provider === 'ssh' ? [this.prisma.codeRepository.delete({ where: { projectId } })] : []),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'ssh_key_created', details: { fingerprint: data.fingerprint, rotated: Boolean(existing), project: access.name.slice(0, 80) } } }),
    ]);
    const row = await this.prisma.sshDeployKey.findUnique({ where: { projectId } });
    return { data: { key: this.sshKeyView(row), available: true } };
  }

  /** The server's host keys to show the owner before anything is trusted. */
  async sshHostKeys(userId: string, projectId: string, repoUrl: string) {
    await this.access(userId, projectId, true);
    await this.sshReady();
    let remote: SshRemote;
    try { remote = parseSshUrl(repoUrl); } catch (error) { throw new BadRequestException(error instanceof GitProviderError ? error.code : 'REPO_SSH_URL_INVALID'); }
    const address = await this.sshAddress(remote);
    try {
      const keys = await scanHostKeys(remote, address);
      return { data: { host: remote.host, port: remote.port, url: sshDisplayUrl(remote), keys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })) } };
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof GitProviderError ? error.code : 'REPO_SSH_HOST_UNREACHABLE');
    }
  }

  /** Trusts only the host key the owner confirmed, proves the deploy key can read the repository and saves the connection. */
  private async connectSsh(userId: string, projectId: string, input: { repoUrl: string; branch: string | null; hostFingerprint: string | null }, key: Buffer) {
    await this.sshReady();
    const deployKey = await this.prisma.sshDeployKey.findUnique({ where: { projectId } });
    if (!deployKey) throw new ConflictException('SSH_KEY_REQUIRED');
    if (!input.hostFingerprint) throw new BadRequestException('REPO_SSH_HOST_KEY_NOT_CONFIRMED');
    if (input.branch !== null && (!/^[A-Za-z0-9._/-]{1,100}$/.test(input.branch) || input.branch.startsWith('-') || input.branch.includes('..'))) throw new BadRequestException('REPO_BRANCH_INVALID');
    let remote: SshRemote;
    try { remote = parseSshUrl(input.repoUrl); } catch (error) { throw new BadRequestException(error instanceof GitProviderError ? error.code : 'REPO_SSH_URL_INVALID'); }
    const address = await this.sshAddress(remote);
    const privateKey = this.decrypt(deployKey.privateKeyEncrypted, key);
    let branch: string;
    let knownHosts: string;
    try {
      const keys = await scanHostKeys(remote, address);
      const trusted = keys.filter((item) => item.fingerprint === input.hostFingerprint);
      if (!trusted.length) throw new GitProviderError('REPO_SSH_HOST_KEY_MISMATCH');
      knownHosts = trusted.map((item) => item.line).join('\n');
      const info = await new SshGitClient(remote, address, privateKey, knownHosts).inspect();
      branch = input.branch ?? info.defaultBranch ?? 'main';
    } catch (error) {
      if (error instanceof GitProviderError) throw new UnprocessableEntityException(error.code);
      throw error;
    }
    const display = sshDisplayUrl(remote);
    const data = {
      provider: 'ssh', baseUrl: `ssh://${remote.host.includes(':') ? `[${remote.host}]` : remote.host}:${remote.port}`.slice(0, 300), repoPath: remote.path.slice(0, 200), webUrl: display.slice(0, 500),
      defaultBranch: branch, isPrivate: true, tokenEncrypted: deployKey.privateKeyEncrypted, tokenHint: deployKey.fingerprint.slice(-6), connectedVia: 'ssh_key',
      sshKnownHosts: knownHosts, connectedByUserId: userId, verifiedAt: new Date(), lastError: null,
    };
    await this.prisma.$transaction([
      this.prisma.codeRepository.upsert({ where: { projectId }, create: { projectId, ...data }, update: data }),
      this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_connected', details: { provider: 'ssh', repoPath: display, via: 'ssh_key', hostFingerprint: input.hostFingerprint } } }),
    ]);
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'code_hosting' } } });
    if (choice) await this.prisma.projectChoice.update({ where: { id: choice.id }, data: { stepsDone: [...new Set([...choice.stepsDone, 'ssh_key', 'connect'])] } });
    return this.card(userId, projectId, 'code_hosting');
  }

  /** Pushes over SSH: the server name is resolved and checked again, and only the confirmed host key is trusted. */
  private async sshCommit(repo: { baseUrl: string; repoPath: string; webUrl: string; defaultBranch: string; tokenEncrypted: string; sshKnownHosts: string | null }, key: Buffer, files: GitFile[], message: string) {
    if (!repo.sshKnownHosts) throw new GitProviderError('REPO_SSH_HOST_KEY_CHANGED');
    if (!(await sshToolsAvailable())) throw new ServiceUnavailableException('SSH_GIT_NOT_AVAILABLE');
    const remote = parseSshUrl(repo.webUrl);
    const address = await this.sshAddress(remote);
    const { commit } = await new SshGitClient(remote, address, this.decrypt(repo.tokenEncrypted, key), repo.sshKnownHosts).commit(repo.defaultBranch, files, message);
    return { commitUrl: '', commit };
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
  private async files(userId: string, projectId: string, options: { ci?: boolean; provider?: GitProviderKey; branch?: string } = {}) {
    return runWithLocale(await this.projectLocale(projectId), async () => {
      const base = await this.repositoryFiles(userId, projectId);
      const infra = await this.infraState(projectId);
      const files = [...base.files];
      // Render builds from the repository: the Blueprint goes with the site when Render is the chosen place.
      if (infra.deployment === 'render' && base.siteIncluded) files.push(renderBlueprint((await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }))?.name ?? 'site'));
      // Pipelines exist for the services with CI; a plain git server over SSH has none BuildPath can write for.
      const ciAvailable = base.siteIncluded && infra.kind !== 'store' && infra.kind !== null && options.provider !== 'ssh';
      if (options.ci && !ciAvailable) throw new ConflictException('CI_NOT_AVAILABLE');
      if (options.ci && options.provider && options.provider !== 'ssh' && infra.kind && infra.kind !== 'store') {
        if (infra.kind === 'booking') {
          // The booking program for the server goes with the pipeline: the same app/ files as in the server package.
          let bundle: string;
          try { bundle = await bookingBundle(); } catch { throw new ServiceUnavailableException('EXPORT_NOT_BUILT'); }
          for (const file of bookingPackageFiles(infra.artifact!, bundle).filter((item) => item.name.startsWith('app/'))) files.push({ path: `${BOOKING_APP_DIR}/${file.name.slice('app/'.length)}`, content: file.content });
        }
        files.push(ciDeployFile(options.provider, options.branch ?? 'main', infra.kind));
      }
      return { ...base, files, ciAvailable, ciKind: infra.kind === 'booking' ? 'booking' as const : 'static' as const };
    });
  }

  /** What the infrastructure files depend on: the chosen place and what the accepted site is (plain pages, booking, store). */
  private async infraState(projectId: string): Promise<{ deployment: string | null; kind: 'static' | 'booking' | 'store' | null; artifact: SiteArtifact | null }> {
    const [choice, build] = await Promise.all([
      this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'deployment' } }, select: { optionKey: true } }),
      this.prisma.projectStage.findFirst({ where: { projectId, stageKey: 'build' }, select: { approvedVersionId: true } }),
    ]);
    const artifact = build?.approvedVersionId ? (await this.prisma.stageArtifactVersion.findUnique({ where: { id: build.approvedVersionId }, select: { content: true } }))?.content as unknown as SiteArtifact | undefined : undefined;
    const kind = !artifact ? null : artifact.meta?.store ? 'store' : artifact.meta?.booking ? 'booking' : 'static';
    return { deployment: choice?.optionKey ?? null, kind, artifact: artifact ?? null };
  }

  /** README and instructions are project files: in the project's language. */
  private async projectLocale(projectId: string) {
    return contentLocale((await this.prisma.project.findUnique({ where: { id: projectId }, select: { locale: true } }))?.locale);
  }

  private async repositoryFiles(userId: string, projectId: string): Promise<{ files: GitFile[]; siteIncluded: boolean; complete: boolean }> {
    const result = (await this.journey.result(userId, projectId)).data as { complete: boolean; files: Array<{ name: string; content: string }> };
    const pick = (name: string) => result.files.find((file) => file.name === name)?.content;
    const files: GitFile[] = [];
    const site = pick('site.html');
    if (site) files.push({ path: 'index.html', content: site });
    for (const file of result.files) if (file.name.startsWith('pages/')) files.push({ path: file.name.slice('pages/'.length), content: file.content });
    const md = pick('project.md'); if (md) files.push({ path: 'project.md', content: md });
    const json = pick('project.json'); if (json) files.push({ path: 'project.json', content: json });
    files.push({ path: 'README.md', content: [
      tr("# Сайт, созданный в BuildPath"), '',
      site ? tr("- `index.html` — готовая страница сайта. Её можно открыть в браузере или загрузить на любой хостинг статических сайтов.") : tr("- Сайт ещё не собран: здесь только описание проекта."),
      tr("- `project.md` — паспорт проекта и все тексты."), tr("- `project.json` — все данные проекта для разработчика или переноса."), '',
      tr("Файлы обновляются из BuildPath по кнопке «Отправить в репозиторий». Ручные изменения в этих файлах будут заменены при следующей отправке."), '',
    ].join('\n') });
    return { files, siteIncluded: Boolean(site), complete: result.complete };
  }

  async pushPreview(userId: string, projectId: string, ci = false) {
    await this.access(userId, projectId, true);
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    const { files, siteIncluded, complete, ciAvailable, ciKind } = await this.files(userId, projectId, { ci, provider: repo.provider as GitProviderKey, branch: repo.defaultBranch });
    return { data: {
      repository: this.repositoryView(repo), branch: repo.defaultBranch, files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.content) })), siteIncluded, complete,
      ci: { available: ciAvailable, included: ci, kind: ciKind, secrets: ['SSH_HOST', 'SSH_USER', 'SSH_PRIVATE_KEY', 'SSH_KNOWN_HOSTS'], optional: ['DEPLOY_PATH', 'SSH_PORT'] },
    } };
  }

  /** Sends accepted results to the connected repository. Requires explicit confirmation every time. */
  async push(userId: string, projectId: string, confirm: boolean, ci = false) {
    if (!confirm) throw new BadRequestException('CONFIRMATION_REQUIRED');
    const access = await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    const { files } = await this.files(userId, projectId, { ci, provider: repo.provider as GitProviderKey, branch: repo.defaultBranch });
    const token = this.decrypt(repo.tokenEncrypted, key);
    try {
      const message = tr("BuildPath: {0} — принятая версия", [access.name]);
      const pushed: { commitUrl: string; commit?: string } = repo.provider === 'ssh'
        ? await this.sshCommit(repo, key, files, message)
        : await this.client(repo.provider as ApiGitProviderKey, token, repo.baseUrl).commit(repo.repoPath, repo.defaultBranch, files, message);
      await this.prisma.$transaction([
        this.prisma.codeRepository.update({ where: { projectId }, data: { lastPushAt: new Date(), lastCommitUrl: pushed.commitUrl || null, lastError: null } }),
        this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_pushed', details: { repoPath: repo.repoPath, files: files.map((file) => file.path), commitUrl: pushed.commitUrl, commit: pushed.commit ?? null, ci } } }),
      ]);
    } catch (error) {
      if (error instanceof HttpException) {
        await this.prisma.codeRepository.update({ where: { projectId }, data: { lastError: String(error.message).slice(0, 80) } });
        throw error;
      }
      const code = error instanceof GitProviderError ? error.code : 'REPO_PROVIDER_FAILED';
      await this.prisma.codeRepository.update({ where: { projectId }, data: { lastError: code } });
      throw new UnprocessableEntityException(code);
    }
    return this.card(userId, projectId, 'code_hosting');
  }

  /**
   * Work that is not the accepted version (the AI agent's code) goes to its own branch made from the main one, with a pull
   * request for people to review; the main branch is never written. An empty repository has nothing to branch from, so the
   * work becomes its first commit on the main branch. A plain git server over SSH gets the branch without a request.
   */
  async pushBranch(userId: string, projectId: string, input: { branch: string; files: GitFile[]; message: string; title: string; body: string }) {
    await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    try {
      if (repo.provider === 'ssh') {
        if (!repo.sshKnownHosts) throw new GitProviderError('REPO_SSH_HOST_KEY_CHANGED');
        if (!(await sshToolsAvailable())) throw new ServiceUnavailableException('SSH_GIT_NOT_AVAILABLE');
        const remote = parseSshUrl(repo.webUrl);
        const { commit } = await new SshGitClient(remote, await this.sshAddress(remote), this.decrypt(repo.tokenEncrypted, key), repo.sshKnownHosts).commit(input.branch, input.files, input.message, repo.defaultBranch);
        await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_branch_pushed', details: { branch: input.branch, commit, files: input.files.length } } });
        return { branch: input.branch, commitUrl: null, pullRequestUrl: null, mainBranch: false, repository: this.repositoryView(repo) };
      }
      const client = this.client(repo.provider as ApiGitProviderKey, this.decrypt(repo.tokenEncrypted, key), repo.baseUrl);
      const branch = await client.ensureBranch(repo.repoPath, input.branch, repo.defaultBranch);
      const target = branch.empty ? repo.defaultBranch : input.branch;
      const { commitUrl } = await client.commit(repo.repoPath, target, input.files, input.message);
      const pullRequestUrl = branch.empty ? null : (await client.openPullRequest(repo.repoPath, { head: input.branch, base: repo.defaultBranch, title: input.title, body: input.body })).url || null;
      await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_branch_pushed', details: { branch: target, commitUrl, pullRequestUrl, files: input.files.length } } });
      return { branch: target, commitUrl: commitUrl || null, pullRequestUrl, mainBranch: branch.empty, repository: this.repositoryView(repo) };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = error instanceof GitProviderError ? error.code : 'REPO_PROVIDER_FAILED';
      await this.prisma.codeRepository.update({ where: { projectId }, data: { lastError: code } });
      throw new UnprocessableEntityException(code);
    }
  }

  /**
   * The code on the repository's main branch, read back for a change task (the agent's step 5): text files within limits,
   * never secrets or build output. The key stays here; the files, not the key, go to the agent's sandbox.
   */
  async readMainBranch(userId: string, projectId: string): Promise<RepoSnapshot> {
    await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    if (!repo) throw new NotFoundException('REPO_NOT_CONNECTED');
    let snapshot: RepoSnapshot | null;
    try {
      if (repo.provider === 'ssh') {
        if (!repo.sshKnownHosts) throw new GitProviderError('REPO_SSH_HOST_KEY_CHANGED');
        if (!(await sshToolsAvailable())) throw new ServiceUnavailableException('SSH_GIT_NOT_AVAILABLE');
        const remote = parseSshUrl(repo.webUrl);
        snapshot = await new SshGitClient(remote, await this.sshAddress(remote), this.decrypt(repo.tokenEncrypted, key), repo.sshKnownHosts).readBranch(repo.defaultBranch);
      } else {
        snapshot = await this.client(repo.provider as ApiGitProviderKey, this.decrypt(repo.tokenEncrypted, key), repo.baseUrl).readBranch(repo.repoPath, repo.defaultBranch);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const code = error instanceof GitProviderError ? error.code : 'REPO_PROVIDER_FAILED';
      await this.prisma.codeRepository.update({ where: { projectId }, data: { lastError: code } });
      throw new UnprocessableEntityException(code);
    }
    if (!snapshot || !snapshot.files.length) throw new ConflictException('REPO_BRANCH_EMPTY');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'repository_branch_read', details: { branch: snapshot.branch, commit: snapshot.commit, files: snapshot.files.length, truncated: snapshot.truncated } } });
    return snapshot;
  }

  /** Which repository the agent's work would go to, for the confirmation; null when none is connected. */
  async repositoryFor(projectId: string) {
    const repo = await this.prisma.codeRepository.findUnique({ where: { projectId } });
    return repo ? this.repositoryView(repo) : null;
  }

  /** Options that depend on another decision: available only when that decision is made (and, for GitHub, connected). */
  private async requirementsMet(projectId: string, cardKey: CardKey): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    for (const option of choiceCards[cardKey].options) {
      if (!option.requires) continue;
      const other = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: option.requires.card } }, select: { optionKey: true } });
      const repo = option.requires.card === 'code_hosting' ? await this.prisma.codeRepository.findUnique({ where: { projectId }, select: { provider: true } }) : null;
      const allowed = Array.isArray(option.requires.option) ? option.requires.option : [option.requires.option];
      result[option.key] = Boolean(other && allowed.includes(other.optionKey)) && (option.requires.card !== 'code_hosting' || Boolean(repo && allowed.includes(repo.provider)));
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
    const hosting = await this.prisma.hostingConnection.findUnique({ where: { projectId } });
    return {
      siteAccepted: Boolean(buildId),
      publication: publication ? { status: publication.status, slug: publication.slug, upToDate: publication.buildVersionId === buildId } : null,
      repository: repo ? { provider: repo.provider, repoPath: repo.repoPath, pushedAt: repo.lastPushAt } : null,
      hosting: hosting ? {
        provider: hosting.provider, account: hosting.account, siteUrl: hosting.siteUrl, adminUrl: hosting.adminUrl, tokenHint: `…${hosting.tokenHint}`,
        deployedAt: hosting.lastDeployAt, upToDate: Boolean(buildId) && hosting.lastBuildVersionId === buildId, lastError: hosting.lastError,
      } : null,
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
      // On a connected hosting the site address is known; the owner may still check another one (their own domain there).
      if (!url && HOSTING_PROVIDERS.includes(choice.optionKey as HostingProviderKey)) url = (await this.prisma.hostingConnection.findUnique({ where: { projectId }, select: { siteUrl: true } }))?.siteUrl || null;
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

  /**
   * Connects an external hosting: checks the token, creates a site in the owner's account (or takes one by its ID) and keeps the
   * token encrypted. Creating a site there is an action in the owner's account, so it needs explicit confirmation.
   */
  async hostingConnect(userId: string, projectId: string, input: { provider: string; token: string; siteId: string | null; confirm: boolean }, fetchImpl?: typeof fetch) {
    if (!input.confirm) throw new BadRequestException('CONFIRMATION_REQUIRED');
    const access = await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    if (!HOSTING_PROVIDERS.includes(input.provider as HostingProviderKey)) throw new BadRequestException('HOSTING_PROVIDER_UNKNOWN');
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'deployment' } }, select: { optionKey: true } });
    if (choice?.optionKey !== input.provider) throw new ConflictException('HOSTING_NOT_CHOSEN');
    try {
      const provider = hostingProvider(input.provider, input.token, fetchImpl);
      const { account } = await provider.verify();
      const site = await provider.site(input.siteId, access.name);
      const data = {
        provider: input.provider, account: account.slice(0, 120), siteId: site.siteId, siteUrl: site.url.slice(0, 300), adminUrl: site.adminUrl?.slice(0, 300) ?? null,
        tokenEncrypted: this.encrypt(input.token, key), tokenHint: input.token.slice(-4), connectedByUserId: userId, lastError: null,
        lastDeployAt: null, lastDeployId: null, lastBuildVersionId: null,
      };
      await this.prisma.$transaction([
        this.prisma.hostingConnection.upsert({ where: { projectId }, create: { projectId, ...data }, update: data }),
        this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'hosting_connected', details: { provider: input.provider, siteId: site.siteId, created: !input.siteId } } }),
      ]);
      await this.markDeploymentStep(projectId, 'connect', true);
    } catch (error) {
      if (error instanceof HostingError) throw new UnprocessableEntityException(error.code);
      throw error;
    }
    return this.card(userId, projectId, 'deployment');
  }

  /** Sends the accepted page to the connected hosting. Every deploy is confirmed by the owner. */
  async hostingDeploy(userId: string, projectId: string, confirm: boolean, fetchImpl?: typeof fetch) {
    if (!confirm) throw new BadRequestException('CONFIRMATION_REQUIRED');
    await this.access(userId, projectId, true);
    const key = this.key();
    if (!key) throw new ServiceUnavailableException('REPO_CONNECT_NOT_CONFIGURED');
    const connection = await this.prisma.hostingConnection.findUnique({ where: { projectId } });
    if (!connection) throw new NotFoundException('HOSTING_NOT_CONNECTED');
    const buildId = await this.acceptedBuildId(projectId);
    const result = (await this.journey.result(userId, projectId)).data as { files: Array<{ name: string; content: string }> };
    const page = result.files.find((file) => file.name === 'site.html')?.content;
    if (!buildId || !page) throw new ConflictException('SITE_NOT_ACCEPTED');
    const token = decryptToken(connection.tokenEncrypted, key);
    if (token === null) throw new ServiceUnavailableException('HOSTING_RECONNECT_REQUIRED');
    try {
      const deployed = await hostingProvider(connection.provider, token, fetchImpl).deploy(connection.siteId, [{ path: 'index.html', content: page }]);
      await this.prisma.$transaction([
        this.prisma.hostingConnection.update({ where: { projectId }, data: { lastDeployAt: new Date(), lastDeployId: deployed.deployId.slice(0, 80), lastBuildVersionId: buildId, lastError: null, ...(deployed.url ? { siteUrl: deployed.url.slice(0, 300) } : {}) } }),
        this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'hosting_deployed', details: { provider: connection.provider, siteId: connection.siteId, deployId: deployed.deployId, buildVersionId: buildId } } }),
      ]);
      await this.markDeploymentStep(projectId, 'deploy', true);
    } catch (error) {
      const code = error instanceof HostingError ? error.code : 'HOSTING_FAILED';
      await this.prisma.hostingConnection.update({ where: { projectId }, data: { lastError: code } });
      throw new UnprocessableEntityException(code);
    }
    return this.card(userId, projectId, 'deployment');
  }

  /** Forgets the token and the site link here; the site itself stays in the owner's hosting account. */
  async hostingDisconnect(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const removed = await this.prisma.hostingConnection.deleteMany({ where: { projectId } });
    if (!removed.count) throw new NotFoundException('HOSTING_NOT_CONNECTED');
    await this.prisma.projectEvent.create({ data: { projectId, actorUserId: userId, type: 'hosting_disconnected', details: {} } });
    await this.markDeploymentStep(projectId, 'connect', false);
    await this.markDeploymentStep(projectId, 'deploy', false);
    return this.card(userId, projectId, 'deployment');
  }

  private async markDeploymentStep(projectId: string, stepKey: string, done: boolean) {
    const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId, cardKey: 'deployment' } }, select: { id: true, stepsDone: true } });
    if (!choice) return;
    const steps = new Set(choice.stepsDone);
    if (done) steps.add(stepKey); else steps.delete(stepKey);
    await this.prisma.projectChoice.update({ where: { id: choice.id }, data: { stepsDone: [...steps] } });
  }

  /** Files for an own server: the accepted page, a Caddy config with automatic HTTPS, a compose file and plain instructions. */
  async serverPackage(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    return runWithLocale(await this.projectLocale(projectId), () => this.serverPackageIn(userId, projectId));
  }

  private async serverPackageIn(userId: string, projectId: string) {
    await this.access(userId, projectId, true);
    const result = (await this.journey.result(userId, projectId)).data as { files: Array<{ name: string; content: string }> };
    const site = result.files.find((file) => file.name === 'site.html')?.content;
    if (!site) throw new ConflictException('SITE_NOT_ACCEPTED');
    const build = await this.prisma.projectStage.findFirst({ where: { projectId, stageKey: 'build' }, select: { approvedVersionId: true } });
    const artifact = build?.approvedVersionId ? (await this.prisma.stageArtifactVersion.findUnique({ where: { id: build.approvedVersionId }, select: { content: true } }))?.content as unknown as SiteArtifact | undefined : undefined;
    // Orders need the BuildPath sites server; a static copy of the store would show a cart that cannot take orders.
    if (artifact?.meta?.store) throw new ConflictException('STORE_NEEDS_BUILDPATH');
    if (artifact?.meta?.booking) {
      // Online booking needs a program on the server, not just a page: ship the bundled booking app with the accepted schedule.
      let bundle: string;
      try { bundle = await bookingBundle(); } catch { throw new ServiceUnavailableException('EXPORT_NOT_BUILT'); }
      return { data: { folder: 'buildpath-site', kind: 'booking_app', files: bookingPackageFiles(artifact, bundle) } };
    }
    const caddy = [tr("# Замените ВАШ-ДОМЕН.kz на свой домен. Caddy сам получит HTTPS-сертификат."), tr("ВАШ-ДОМЕН.kz {"), '\troot * /srv', '\tfile_server', '\tencode gzip', '\theader {', '\t\tX-Content-Type-Options nosniff', '\t\tReferrer-Policy strict-origin-when-cross-origin', '\t}', '}', ''].join('\n');
    const compose = ['services:', '  site:', '    image: caddy:2', '    restart: unless-stopped', '    ports: ["80:80", "443:443"]', '    volumes:', '      - ./Caddyfile:/etc/caddy/Caddyfile:ro', '      - ./site:/srv:ro', '      - caddy_data:/data', 'volumes:', '  caddy_data: {}', ''].join('\n');
    const readme = [
      tr("# Как запустить сайт на своём сервере"), '',
      tr("Нужно: сервер с Ubuntu 24.04 и домен, направленный на IP сервера (запись A)."), '',
      tr("1. В файле `Caddyfile` замените `ВАШ-ДОМЕН.kz` на свой домен."),
      tr("2. Скопируйте папку с файлами на сервер, например так (на своём компьютере): `scp -r buildpath-site root@IP-СЕРВЕРА:/opt/`"),
      tr("3. Подключитесь к серверу: `ssh root@IP-СЕРВЕРА` и выполните:"), '',
      '```', 'curl -fsSL https://get.docker.com | sh', 'cd /opt/buildpath-site', 'docker compose up -d', '```', '',
      tr("4. Через минуту откройте свой домен в браузере. Вернитесь в BuildPath и нажмите «Проверить адрес»."), '',
      tr("Обновить сайт: замените файлы в папке `site` новыми из BuildPath — перезапускать ничего не нужно."), '',
      tr("Форма заявок BuildPath на своём сервере не работает: на сайте останутся кнопки звонка и мессенджера."), '',
      tr("## Обновлять автоматически"), '',
      tr("Если код хранится в репозитории (GitHub, GitLab, Gitea или Bitbucket), при отправке из BuildPath отметьте «Выкладывать на мой сервер автоматически». После каждой отправки сайт сам обновится на сервере. В настройках репозитория нужны секреты SSH_HOST, SSH_USER, SSH_PRIVATE_KEY и SSH_KNOWN_HOSTS — как их получить, написано в BuildPath."), '',
      tr("## Запустить как контейнер"), '',
      tr("`Dockerfile` собирает образ сайта для любого сервиса, который запускает Docker-контейнеры: `docker build -t my-site . && docker run -p 8080:80 my-site`. HTTPS в этом случае даёт сам сервис."), '',
    ].join('\n');
    return {
      data: {
        folder: 'buildpath-site', kind: 'static',
        files: [
          { name: 'site/index.html', mimeType: 'text/html', content: site },
          ...result.files.filter((file) => file.name.startsWith('pages/')).map((file) => ({ name: `site/${file.name.slice('pages/'.length)}`, mimeType: 'text/html', content: file.content })),
          { name: 'Caddyfile', mimeType: 'text/plain', content: caddy },
          { name: 'compose.yaml', mimeType: 'text/yaml', content: compose },
          { name: 'Dockerfile', mimeType: 'text/plain', content: staticDockerfile() },
          { name: 'README.md', mimeType: 'text/markdown', content: readme },
        ],
      },
    };
  }
}
