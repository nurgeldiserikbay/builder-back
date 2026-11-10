import 'dotenv/config';
import { PrismaService } from './database/prisma.service.js';
import { createSitesServer, sitesOptionsFromEnv } from './sites/sites-server.js';
import { initErrorReporting } from './observability/error-reporting.js';

initErrorReporting('sites');

const prisma = new PrismaService();
const { server, cleanup } = createSitesServer(prisma, sitesOptionsFromEnv(prisma));
const port = Number(process.env.SITES_PORT ?? 4100);
server.listen(port, '0.0.0.0', () => console.log(`BuildPath sites server on :${port}`));
const timer = setInterval(() => { cleanup().catch(() => undefined); }, 60 * 60 * 1000);
void cleanup().catch(() => undefined);

const shutdown = () => { clearInterval(timer); server.close(() => { void prisma.$disconnect().then(() => process.exit(0)); }); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
