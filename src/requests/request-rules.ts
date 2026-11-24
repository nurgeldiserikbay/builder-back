// «Заявки на этап»: validation and the rules of who may do what. Pure, tested without a database.
import { BadRequestException } from '@nestjs/common';

export const REQUEST_OPEN_DAYS = 14;
export const MAX_OPEN_REQUESTS_PER_PROJECT = 10;

export type RequestInput = { role: 'lead' | 'consultant'; description: string; payKind: 'fixed' | 'hourly' | 'any'; budgetTiyn: number | null; days: number };
export type ResponseInput = { message: string; payKind: 'fixed' | 'hourly'; fixedAmountTiyn: number | null; hourlyRateTiyn: number | null; hourLimit: number | null; days: number };

function record(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('INVALID_REQUEST_BODY');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !fields.includes(key))) throw new BadRequestException('UNKNOWN_FIELD');
  return input;
}
function text(value: unknown, code: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new BadRequestException(code);
  const clean = value.replace(/\r\n/g, '\n').trim();
  if (clean.length < min || clean.length > max) throw new BadRequestException(code);
  return clean;
}
function whole(value: unknown, code: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new BadRequestException(code);
  return value;
}

/** { role, description, payKind, budget (tenge or null), days } */
export function parseRequest(raw: unknown): RequestInput {
  const input = record(raw, ['role', 'description', 'payKind', 'budget', 'days']);
  if (input.role !== 'lead' && input.role !== 'consultant') throw new BadRequestException('INVALID_ROLE');
  const payKind = input.payKind ?? 'any';
  if (payKind !== 'fixed' && payKind !== 'hourly' && payKind !== 'any') throw new BadRequestException('INVALID_PAYKIND');
  const budget = input.budget === undefined || input.budget === null ? null : whole(input.budget, 'INVALID_BUDGET', 1000, 100_000_000);
  return {
    role: input.role, description: text(input.description, 'INVALID_DESCRIPTION', 30, 2000), payKind,
    budgetTiyn: budget === null ? null : budget * 100, days: whole(input.days, 'INVALID_DAYS', 1, 180),
  };
}

/** { message, payKind, fixedAmount | hourlyRate + hourLimit (tenge, hours), days } — the same bounds as an invitation. */
export function parseResponse(raw: unknown): ResponseInput {
  const input = record(raw, ['message', 'payKind', 'fixedAmount', 'hourlyRate', 'hourLimit', 'days']);
  if (input.payKind !== 'fixed' && input.payKind !== 'hourly') throw new BadRequestException('INVALID_PAYKIND');
  const fixed = input.payKind === 'fixed';
  return {
    message: text(input.message, 'INVALID_MESSAGE', 20, 1000),
    payKind: input.payKind,
    fixedAmountTiyn: fixed ? whole(input.fixedAmount, 'INVALID_FIXEDAMOUNT', 1000, 100_000_000) * 100 : null,
    hourlyRateTiyn: fixed ? null : whole(input.hourlyRate, 'INVALID_HOURLYRATE', 500, 1_000_000) * 100,
    hourLimit: fixed ? null : whole(input.hourLimit, 'INVALID_HOURLIMIT', 1, 1000),
    days: whole(input.days, 'INVALID_DAYS', 1, 180),
  };
}

/** A response must use the way of paying the owner asked for (any — either). */
export function payKindAllowed(requested: string, offered: string): boolean {
  return requested === 'any' || requested === offered;
}

/** Open means: not filled or cancelled and not past its closing time. */
export function isOpen(request: { status: string; closesAt: Date }, now: Date = new Date()): boolean {
  return request.status === 'open' && request.closesAt > now;
}

export type ResponderState = { profile: 'none' | 'draft' | 'published' | 'blocked'; memberOfProject: boolean; assignedToStage: boolean; isAuthor: boolean };
/** Why a person cannot respond, or null when they can. */
export function cannotRespond(state: ResponderState): string | null {
  if (state.isAuthor || state.memberOfProject) return 'OWN_PROJECT';
  if (state.profile === 'blocked') return 'PROFILE_BLOCKED';
  if (state.profile !== 'published') return 'PROFILE_NOT_PUBLISHED';
  if (state.assignedToStage) return 'ALREADY_ON_STAGE';
  return null;
}

/** The most the owner would pay under a response, to compare with the request's budget. */
export function responseTotalTiyn(response: Pick<ResponseInput, 'payKind' | 'fixedAmountTiyn' | 'hourlyRateTiyn' | 'hourLimit'>): number {
  return response.payKind === 'fixed' ? response.fixedAmountTiyn ?? 0 : (response.hourlyRateTiyn ?? 0) * (response.hourLimit ?? 0);
}
