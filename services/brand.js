function brandName(env = process.env) {
  const name = String(env.SITE_NAME || '').replace(/[\r\n<>"]/g, ' ').trim().slice(0, 60);
  return name || 'Threadly';
}

module.exports = { brandName };
