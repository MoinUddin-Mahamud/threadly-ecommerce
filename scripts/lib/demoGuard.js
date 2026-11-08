// Returns the reason demo:reset must not run, or null when it may.
function demoResetProblem(env = process.env) {
  if (env.DEMO_MODE !== 'true') {
    return 'Set DEMO_MODE=true first. This script deletes orders, coupons, reviews, payouts, customer accounts and products, and is for demo sites only.';
  }
  if (!env.DEMO_ADMIN_PASSWORD) {
    return 'Set DEMO_ADMIN_PASSWORD in the environment (8+ characters). There is no default.';
  }
  const db = String(env.DB_NAME || 'ecommerce');
  if (!/demo/i.test(db) && env.DEMO_ALLOW_ANY_DB !== 'true') {
    return `DB_NAME is "${db}", which does not contain "demo". Use a separate demo database (for example DB_NAME=threadly_demo), or set DEMO_ALLOW_ANY_DB=true if you are sure this database holds nothing you need.`;
  }
  return null;
}

module.exports = { demoResetProblem };
