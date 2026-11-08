import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaService } from '../src/database/prisma.service.js';
import { StaffAuthService, type StaffRole } from '../src/admin/staff-auth.service.js';

const roles: StaffRole[] = ['super_admin', 'quality_admin', 'operations_auditor'];
const email = process.env.STAFF_INITIAL_EMAIL?.trim();
const password = process.env.STAFF_INITIAL_PASSWORD;
const displayName = process.env.STAFF_INITIAL_DISPLAY_NAME?.trim();
const role = process.env.STAFF_INITIAL_ROLE as StaffRole | undefined;
if (!email || !password || !displayName || !role) {
  throw new Error('Set STAFF_INITIAL_EMAIL, STAFF_INITIAL_PASSWORD, STAFF_INITIAL_DISPLAY_NAME, and STAFF_INITIAL_ROLE explicitly.');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Invalid staff email.');
if (password.length < 12 || password.length > 128) throw new Error('Staff password must be 12–128 characters.');
if (displayName.length < 1 || displayName.length > 120 || !roles.includes(role)) throw new Error('Invalid staff display name or role.');

const prisma = new PrismaService();
try {
  const emailNormalized = email.toLowerCase();
  const existing = await prisma.staffAccount.findUnique({ where: { emailNormalized } });
  if (existing) throw new Error('A staff account with this email already exists; use the account management workflow instead.');
  const passwordHash = await StaffAuthService.hashPassword(password);
  const account = await prisma.staffAccount.create({ data: { email, emailNormalized, displayName, role, passwordHash } });
  await prisma.adminAuditEvent.create({ data: { staffId: account.id, eventType: 'staff.account_bootstrapped' } });
  stdout.write(`Created staff account ${account.email} with role ${account.role}.\n`);
} finally {
  await prisma.$disconnect();
}
