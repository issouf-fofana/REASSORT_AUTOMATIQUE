const systemConfig = require('./systemConfigService');

async function getJwtConfig() {
  const [secret, expiresIn] = await Promise.all([
    systemConfig.getValue(systemConfig.KEYS.JWT_SECRET),
    systemConfig.getValue(systemConfig.KEYS.JWT_EXPIRES_IN),
  ]);
  return { secret, expiresIn };
}

module.exports = { getJwtConfig };
