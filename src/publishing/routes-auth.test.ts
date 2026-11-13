import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { MastersController, PublishingController, QuickEditController } from './publishing.controller.js';

/** Routes of these controllers that are public on purpose. Everything else must require a signed-in user. */
const PUBLIC = new Set<string>([
  'PublishingController.webhook', // Telegram Bot API; checked by the secret token Telegram sends in a header
  'MastersController.inviteInfo', // what an invitation link is about, shown before the master signs in; the token is the key
]);

describe('publishing routes', () => {
  it('require a signed-in user unless they are public on purpose', () => {
    const open: string[] = [];
    for (const controller of [PublishingController, MastersController, QuickEditController]) {
      const onClass = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const guards = [...onClass, ...((Reflect.getMetadata(GUARDS_METADATA, (controller.prototype as unknown as Record<string, unknown>)[name] as object) ?? []) as unknown[])];
        if (!guards.includes(AuthGuard) && !PUBLIC.has(`${controller.name}.${name}`)) open.push(`${controller.name}.${name}`);
      }
    }
    assert.deepEqual(open, []);
  });
});
