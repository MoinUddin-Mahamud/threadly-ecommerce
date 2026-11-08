// Puts a public demo back to its starting state: removes orders, coupons, reviews, payouts and
// customer accounts, then reseeds the products and recreates the demo owner.
// Run it nightly from cron:  npm run demo:reset -- --yes
// Needs DEMO_MODE=true, DEMO_ADMIN_PASSWORD and a database whose name contains "demo".
// Pass --yes (or set CONFIRM=yes) to run it; without that it only prints what it would remove.
require('dotenv').config({ quiet: true });
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { demoResetProblem } = require('./lib/demoGuard');

const problem = demoResetProblem(process.env);
if (problem) {
  console.error(problem);
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI is missing in .env');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const run = (args, env) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

(async () => {
  const mongoose = require('mongoose');
  const { purgeDemoData, countDemoData } = require('./lib/demoPurge');
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || 'ecommerce' });
  const confirmed = process.argv.includes('--yes') || process.env.CONFIRM === 'yes';
  if (!confirmed) {
    const pending = await countDemoData();
    console.log('Would remove:', Object.entries(pending).map(([k, n]) => `${n} ${k}`).join(', '));
    console.log('Run again with --yes (npm run demo:reset -- --yes) or CONFIRM=yes to do it.');
    await mongoose.disconnect();
    process.exit(1);
  }
  const counts = await purgeDemoData();
  await mongoose.disconnect();
  console.log('Removed:', Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', '));
  // Orders and payouts are gone, so no demo shop is kept in place and the seed can replace them all.
  run(['seed/seed.js', '--reset', '--yes']);
  // "-" makes create-admin read the password from the environment, so it never shows in the process list.
  run(['scripts/create-admin.js', process.env.DEMO_ADMIN_USER || 'demo', '-', 'owner'], { CREATE_ADMIN_PASSWORD: process.env.DEMO_ADMIN_PASSWORD });
  console.log('Demo reset done.');
})().catch((err) => {
  console.error('Demo reset failed:', err.message);
  process.exit(1);
});
