import type { PrismaClient } from '../generated/prisma/client.js';
import { escapeHtml } from '../journey/site-renderer.js';
import { emailConfig, sendEmail } from './email.js';
import { sendTelegramMessage, telegramConfig } from './telegram.js';

export type ChannelStatus = 'sent' | 'failed' | 'off' | 'not_linked' | 'not_configured';

export interface LeadForMessage { name: string; contact: string; message: string | null; siteName: string; projectId: string }

export function leadText(lead: LeadForMessage, appUrl: string | undefined): string {
  return [
    `Новая заявка с сайта «${lead.siteName}»`,
    `Имя: ${lead.name}`,
    `Контакт: ${lead.contact}`,
    lead.message ? `Сообщение: ${lead.message}` : null,
    appUrl ? `Все заявки: ${new URL(`/projects/${lead.projectId}/leads`, appUrl).toString()}` : null,
  ].filter(Boolean).join('\n');
}

/** Notifies the project owner about a stored lead and records the outcome per channel. Never throws. */
export async function notifyLead(prisma: PrismaClient, leadId: string): Promise<{ telegram: ChannelStatus; email: ChannelStatus }> {
  const lead = await prisma.siteLead.findUnique({
    where: { id: leadId },
    select: {
      id: true, name: true, contact: true, message: true, projectId: true,
      publication: { select: { notifyTelegram: true, notifyEmail: true } },
      project: { select: { name: true, owner: { select: { email: true, externalIdentities: { where: { provider: 'telegram' }, select: { chatId: true } } } } } },
    },
  });
  if (!lead) return { telegram: 'failed', email: 'failed' };
  const text = leadText({ name: lead.name, contact: lead.contact, message: lead.message, siteName: lead.project.name, projectId: lead.projectId }, process.env.PUBLIC_APP_URL);

  let telegram: ChannelStatus = 'off';
  if (lead.publication.notifyTelegram) {
    const config = telegramConfig();
    const chatId = lead.project.owner.externalIdentities[0]?.chatId;
    telegram = !config ? 'not_configured' : !chatId ? 'not_linked' : (await sendTelegramMessage(config, chatId, text)) ? 'sent' : 'failed';
  }
  let email: ChannelStatus = 'off';
  if (lead.publication.notifyEmail) {
    const config = emailConfig();
    email = !config ? 'not_configured'
      : (await sendEmail(config, lead.project.owner.email, `Новая заявка: ${lead.project.name}`, `<pre style="font:15px/1.5 system-ui,sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`)) ? 'sent' : 'failed';
  }
  await prisma.siteLead.update({ where: { id: lead.id }, data: { telegramStatus: telegram, emailStatus: email } });
  return { telegram, email };
}
