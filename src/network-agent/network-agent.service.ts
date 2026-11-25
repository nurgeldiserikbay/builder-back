import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../database/prisma.service.js';
import { acceptRoles, editableProject, JourneyCore } from '../journey/journey-core.js';
import { filesDigestOf } from '../agent/agent-tasks.js';
import type { AgentFile } from '../agent/agent-loop.js';
import { RateLimiter } from '../security/rate-limit.js';
import {
  agentState, bearerKey, hashAgentKey, newAgentKey, NETWORK_AGENT_KINDS, NETWORK_AGENT_LIMITS, readHello, readResult, safeRepoPath,
  type NetworkAgentKind,
} from './network-agent.js';

const limits = new RateLimiter();
const AGENT_ACTIVE = ['queued', 'running'];
/** The program the owner runs; one file, Node.js 22 and git, no other dependencies. */
const PROGRAM_PATH = new URL('../../apps/network-agent/buildpath-agent.mjs', import.meta.url);
export const AGENT_PROGRAM_VERSION = '1.0.0';

type AgentRow = NonNullable<Awaited<ReturnType<PrismaService['networkAgent']['findFirst']>>>;
type JobRow = NonNullable<Awaited<ReturnType<PrismaService['networkAgentJob']['findFirst']>>>;

/**
 * «Агент в вашей сети» (PRODUCT_LIFECYCLE §7, step 11). The owner of a web application makes a key and runs the agent in
 * their own network; the agent calls out to BuildPath, takes jobs and reports what happened. The platform asks for three
 * things only — check the application, push code to the internal repository, run the owner's deploy command — and the agent
 * does them against targets it was given on its side, with credentials that never leave the owner's network.
 */
@Injectable()
export class NetworkAgentService {
  constructor(private readonly prisma: PrismaService, private readonly core: JourneyCore) {}

  private async project(userId: string, projectId: string, access: 'members' | 'accept') {
    const ctx = await this.core.load(userId, projectId, access);
    if (ctx.type.key !== 'web_app') throw new NotFoundException('NETWORK_AGENT_NOT_AVAILABLE');
    return ctx;
  }

  private current(projectId: string) {
    return this.prisma.networkAgent.findFirst({ where: { projectId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  /** Jobs nobody took expire; jobs taken and never reported failed. Done lazily on every read. */
  private async sweep(where: { agentId?: string; projectId?: string }) {
    const now = Date.now();
    await this.prisma.networkAgentJob.updateMany({ where: { ...where, status: 'queued', createdAt: { lt: new Date(now - NETWORK_AGENT_LIMITS.queuedMs) } }, data: { status: 'expired', error: 'AGENT_DID_NOT_TAKE', finishedAt: new Date() } });
    await this.prisma.networkAgentJob.updateMany({ where: { ...where, status: 'running', startedAt: { lt: new Date(now - NETWORK_AGENT_LIMITS.runningMs) } }, data: { status: 'failed', error: 'AGENT_DID_NOT_REPORT', finishedAt: new Date() } });
  }

  private agentView(agent: AgentRow | null) {
    if (!agent) return null;
    return {
      id: agent.id, name: agent.name, state: agentState(agent), tokenHint: agent.tokenHint, version: agent.version, appUrl: agent.appUrl,
      capabilities: agent.capabilities ?? null, lastSeenAt: agent.lastSeenAt, expiresAt: agent.expiresAt, createdAt: agent.createdAt,
    };
  }

  private jobView(job: JobRow) {
    const payload = job.payload as { taskId?: string; branch?: string | null } | null;
    return { id: job.id, kind: job.kind, status: job.status, error: job.error, result: job.result ?? null, taskId: payload?.taskId ?? null, branch: payload?.branch ?? null, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt };
  }

  async view(userId: string, projectId: string) {
    const ctx = await this.project(userId, projectId, 'members');
    await this.sweep({ projectId });
    const agent = await this.current(projectId);
    const jobs = await this.prisma.networkAgentJob.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 });
    // The code a push would send: the newest agent task that finished with files.
    const task = await this.prisma.agentTask.findFirst({ where: { projectId, status: 'succeeded', filesDigest: { not: null } }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, moduleKey: true, pushedBranch: true } });
    return {
      data: {
        agent: this.agentView(agent), jobs: jobs.map((job) => this.jobView(job)),
        canManage: ctx.viewer.kind === 'member' && acceptRoles.has(ctx.role) && editableProject(ctx.project.status),
        pushTask: task ? { id: task.id, createdAt: task.createdAt, moduleKey: task.moduleKey } : null,
        // Where the agent calls; the web app fills in its own API address when this one is not configured.
        apiBase: process.env.PUBLIC_API_URL ? `${process.env.PUBLIC_API_URL.replace(/\/+$/, '')}/api/v1` : null,
        programVersion: AGENT_PROGRAM_VERSION, limits: NETWORK_AGENT_LIMITS,
      },
    };
  }

  /** A new key for the project's agent; an earlier key stops working at once. The key is shown only in this answer. */
  async create(userId: string, projectId: string, input: { name?: unknown }) {
    await this.project(userId, projectId, 'accept');
    await limits.take('network-agent-key', projectId, { max: 10, windowMs: 3_600_000 }, 'NETWORK_AGENT_RATE_LIMITED');
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) : 'Агент BuildPath';
    const key = newAgentKey();
    const agent = await this.prisma.$transaction(async (tx) => {
      const old = await tx.networkAgent.findMany({ where: { projectId, revokedAt: null }, select: { id: true } });
      if (old.length) {
        await tx.networkAgent.updateMany({ where: { id: { in: old.map((row) => row.id) } }, data: { revokedAt: new Date() } });
        await tx.networkAgentJob.updateMany({ where: { agentId: { in: old.map((row) => row.id) }, status: 'queued' }, data: { status: 'expired', error: 'AGENT_KEY_REPLACED', finishedAt: new Date() } });
      }
      const created = await tx.networkAgent.create({ data: { projectId, name, tokenHash: key.hash, tokenHint: key.hint, expiresAt: new Date(Date.now() + NETWORK_AGENT_LIMITS.keyDays * 86_400_000), createdById: userId } });
      await this.core.event(tx, projectId, userId, 'network_agent_created', 'handoff', { agentId: created.id, replaced: old.length });
      return created;
    });
    return { data: { token: key.token, agent: this.agentView(agent) } };
  }

  async revoke(userId: string, projectId: string) {
    await this.project(userId, projectId, 'accept');
    const agent = await this.current(projectId);
    if (!agent) throw new NotFoundException('NETWORK_AGENT_NOT_FOUND');
    await this.prisma.$transaction(async (tx) => {
      await tx.networkAgent.update({ where: { id: agent.id }, data: { revokedAt: new Date() } });
      await tx.networkAgentJob.updateMany({ where: { agentId: agent.id, status: 'queued' }, data: { status: 'expired', error: 'AGENT_KEY_REVOKED', finishedAt: new Date() } });
      await this.core.event(tx, projectId, userId, 'network_agent_revoked', 'handoff', { agentId: agent.id });
    });
    return this.view(userId, projectId);
  }

  /**
   * A job for the agent. Pushing code and deploying change the owner's own systems, so they need an explicit confirmation;
   * a check only reads the application's health answer.
   */
  async startJob(userId: string, projectId: string, input: { kind?: unknown; confirm?: unknown; taskId?: unknown }) {
    const ctx = await this.project(userId, projectId, 'accept');
    const kind = input.kind as NetworkAgentKind;
    if (!NETWORK_AGENT_KINDS.includes(kind)) throw new BadRequestException('NETWORK_AGENT_JOB_KIND_INVALID');
    if (kind !== 'check' && input.confirm !== true) throw new BadRequestException('CONFIRMATION_REQUIRED');
    await this.sweep({ projectId });
    const agent = await this.current(projectId);
    if (!agent) throw new NotFoundException('NETWORK_AGENT_NOT_FOUND');
    const state = agentState(agent);
    if (state === 'expired') throw new ConflictException('NETWORK_AGENT_KEY_EXPIRED');
    const caps = (agent.capabilities ?? null) as { check?: boolean; push?: boolean; deploy?: boolean } | null;
    // The agent says what it was set up for; a job it cannot do is refused here rather than failing in the owner's network.
    if (caps && caps[kind] !== true) throw new ConflictException('NETWORK_AGENT_CANNOT_DO');
    if (await this.prisma.networkAgentJob.count({ where: { agentId: agent.id, kind, status: { in: AGENT_ACTIVE } } })) throw new ConflictException('NETWORK_AGENT_JOB_WAITING');
    await limits.take('network-agent-jobs', projectId, { max: NETWORK_AGENT_LIMITS.jobsPerHour, windowMs: 3_600_000 }, 'NETWORK_AGENT_RATE_LIMITED');
    let payload: Record<string, unknown> = {};
    if (kind === 'push') {
      const taskId = typeof input.taskId === 'string' ? input.taskId : '';
      const task = await this.prisma.agentTask.findFirst({ where: { id: taskId, projectId }, select: { id: true, status: true, files: true, filesDigest: true, kind: true, baseFiles: true, baseTaskId: true, moduleKey: true } });
      if (!task) throw new NotFoundException('AGENT_TASK_NOT_FOUND');
      const files = (task.files ?? []) as unknown as AgentFile[];
      if (task.status !== 'succeeded' || !files.length) throw new ConflictException('AGENT_TASK_NO_FILES');
      if (task.filesDigest !== filesDigestOf(files)) throw new ConflictException('AGENT_TASK_FILES_CHANGED');
      // A change removes the files the agent deleted; a first build leaves the repository's other files alone.
      let removed: string[] = [];
      if (task.kind === 'change_app') {
        const base = (task.baseFiles ?? (task.baseTaskId ? (await this.prisma.agentTask.findUnique({ where: { id: task.baseTaskId }, select: { files: true } }))?.files : null) ?? []) as unknown as AgentFile[];
        const kept = new Set(files.map((file) => file.path));
        removed = base.map((file) => file.path).filter((path) => !kept.has(path) && safeRepoPath(path));
      }
      payload = { taskId: task.id, branch: `buildpath/agent-${task.id.slice(0, 8)}`, message: `BuildPath: ${ctx.project.name.slice(0, 60)}${task.moduleKey ? ` — ${task.moduleKey}` : ''} (${task.id.slice(0, 8)})`, removed: removed.slice(0, 500) };
    }
    if (kind === 'deploy') {
      // The branch the last successful push sent, so the owner's command can deploy exactly that code.
      const pushed = await this.prisma.networkAgentJob.findFirst({ where: { agentId: agent.id, kind: 'push', status: 'succeeded' }, orderBy: { finishedAt: 'desc' }, select: { result: true } });
      payload = { branch: (pushed?.result as { branch?: string | null } | null)?.branch ?? null };
    }
    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.networkAgentJob.create({ data: { agentId: agent.id, projectId, kind, payload: payload as never, requestedById: userId } });
      await this.core.event(tx, projectId, userId, 'network_agent_job_started', 'handoff', { jobId: created.id, kind, ...(payload.taskId ? { taskId: payload.taskId } : {}) });
      return created;
    });
    return { data: { job: this.jobView(job) } };
  }

  // ——— The agent's side: authenticated by its key only ———

  private async agentFor(authorization: string | undefined, ip: string | undefined) {
    await limits.take('network-agent-ip', ip ?? 'unknown', { max: 600, windowMs: 3_600_000 }, 'NETWORK_AGENT_RATE_LIMITED');
    const token = bearerKey(authorization);
    if (!token) throw new UnauthorizedException('NETWORK_AGENT_KEY_INVALID');
    const agent = await this.prisma.networkAgent.findUnique({ where: { tokenHash: hashAgentKey(token) } });
    if (!agent) throw new UnauthorizedException('NETWORK_AGENT_KEY_INVALID');
    // A revoked or expired key, or a project that is no longer active, stops the agent: it is told why and stops asking.
    if (agent.revokedAt) throw new ForbiddenException('NETWORK_AGENT_KEY_REVOKED');
    if (agent.expiresAt.getTime() <= Date.now()) throw new ForbiddenException('NETWORK_AGENT_KEY_EXPIRED');
    const project = await this.prisma.project.findUnique({ where: { id: agent.projectId }, select: { status: true } });
    if (!project || !editableProject(project.status)) throw new ForbiddenException('NETWORK_AGENT_PROJECT_INACTIVE');
    await limits.take('network-agent', agent.id, { max: 400, windowMs: 3_600_000 }, 'NETWORK_AGENT_RATE_LIMITED');
    return agent;
  }

  async hello(authorization: string | undefined, ip: string | undefined, body: unknown) {
    const agent = await this.agentFor(authorization, ip);
    const hello = readHello(body);
    const first = !agent.lastSeenAt;
    await this.prisma.networkAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date(), version: hello.version, capabilities: hello.capabilities as never, appUrl: hello.appUrl } });
    if (first) {
      await this.core.event(this.prisma, agent.projectId, agent.createdById, 'network_agent_connected', 'handoff', { agentId: agent.id, version: hello.version, capabilities: hello.capabilities });
      // The «Агент в вашей сети» choice: its step «запустите агента» is done when the agent first calls.
      const choice = await this.prisma.projectChoice.findUnique({ where: { projectId_cardKey: { projectId: agent.projectId, cardKey: 'code_hosting' } }, select: { id: true, optionKey: true, stepsDone: true } });
      if (choice?.optionKey === 'network_agent' && !choice.stepsDone.includes('agent')) await this.prisma.projectChoice.update({ where: { id: choice.id }, data: { stepsDone: [...choice.stepsDone, 'agent'] } });
    }
    return { waitMs: NETWORK_AGENT_LIMITS.waitMs, latestVersion: AGENT_PROGRAM_VERSION };
  }

  /** Waits up to `waitMs` for a job and hands it out once: two agents with one key never take the same job. */
  async next(authorization: string | undefined, ip: string | undefined, wait = NETWORK_AGENT_LIMITS.waitMs) {
    const agent = await this.agentFor(authorization, ip);
    await this.prisma.networkAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
    await this.sweep({ agentId: agent.id });
    const until = Date.now() + Math.min(wait, NETWORK_AGENT_LIMITS.waitMs);
    for (;;) {
      const taken = await this.prisma.$queryRaw<Array<{ id: string; kind: string; payload: unknown }>>`
        UPDATE network_agent_jobs SET status = 'running', started_at = now()
        WHERE id = (SELECT id FROM network_agent_jobs WHERE agent_id = ${agent.id}::uuid AND status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, payload`;
      if (taken[0]) return { job: taken[0] };
      if (Date.now() >= until) return { job: null };
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  private async runningJob(agentId: string, jobId: string) {
    if (!/^[0-9a-f-]{36}$/.test(jobId)) throw new NotFoundException('NETWORK_AGENT_JOB_NOT_FOUND');
    const job = await this.prisma.networkAgentJob.findFirst({ where: { id: jobId, agentId } });
    if (!job) throw new NotFoundException('NETWORK_AGENT_JOB_NOT_FOUND');
    if (job.status !== 'running') throw new ConflictException('NETWORK_AGENT_JOB_NOT_RUNNING');
    return job;
  }

  /** The code a push job sends: the agent task's files, checked against their digest. */
  async files(authorization: string | undefined, ip: string | undefined, jobId: string) {
    const agent = await this.agentFor(authorization, ip);
    const job = await this.runningJob(agent.id, jobId);
    if (job.kind !== 'push') throw new ConflictException('NETWORK_AGENT_JOB_HAS_NO_FILES');
    const taskId = (job.payload as { taskId?: string }).taskId;
    const task = await this.prisma.agentTask.findFirst({ where: { id: taskId, projectId: job.projectId }, select: { files: true, filesDigest: true } });
    const files = (task?.files ?? []) as unknown as AgentFile[];
    if (!task || !files.length || task.filesDigest !== filesDigestOf(files)) throw new ConflictException('AGENT_TASK_FILES_CHANGED');
    return { files: files.filter((file) => safeRepoPath(file.path)) };
  }

  async result(authorization: string | undefined, ip: string | undefined, jobId: string, body: unknown) {
    const agent = await this.agentFor(authorization, ip);
    const job = await this.runningJob(agent.id, jobId);
    const result = readResult(job.kind as NetworkAgentKind, body);
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.networkAgentJob.updateMany({ where: { id: job.id, status: 'running' }, data: { status: result.ok ? 'succeeded' : 'failed', result: result as never, error: result.error, finishedAt: new Date() } });
      if (moved.count !== 1) throw new ConflictException('NETWORK_AGENT_JOB_NOT_RUNNING');
      // The agent's check counts as the application's deployment check: the address is the one inside the owner's network.
      if (result.kind === 'check' && agent.appUrl) {
        const data = { url: agent.appUrl, ok: result.ok, status: result.status, database: result.database, error: result.error?.slice(0, 40) ?? null, checkedAt: new Date(), checkedByUserId: job.requestedById, checkedVia: 'network_agent' };
        await tx.appDeployment.upsert({ where: { projectId: job.projectId }, create: { projectId: job.projectId, ...data }, update: data });
      }
      await tx.networkAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
      await this.core.event(tx, job.projectId, job.requestedById, 'network_agent_job_done', 'handoff', { jobId: job.id, kind: job.kind, ok: result.ok, error: result.error });
    });
    return { ok: true };
  }

  /** The agent program, for the owner to download and run. */
  program() {
    return readFileSync(PROGRAM_PATH, 'utf8');
  }
}
