import { queryD1, executeD1 } from './db.js';

/**
 * Log a warning infraction and enforce 24-hour lockout or permanent ban.
 * @param {string} username - User to warn
 * @param {string} service - 'minecraft'
 * @param {string} reason - Infraction reason
 * @param {string} screenshotProofUrl - URL of uploaded proof
 * @returns {Promise<{warningCount: number, locked: boolean, banned: boolean}>}
 */
export async function triggerWarning(username, service, reason, screenshotProofUrl = '') {
  // 1. Log warning in warns table
  await executeD1(
    'INSERT INTO warns (username, service, reason, screenshot_proof) VALUES (?, ?, ?, ?)',
    [username, service, reason, screenshotProofUrl]
  );

  // 2. Count warnings
  const countRes = await queryD1(
    'SELECT COUNT(*) as cnt FROM warns WHERE username = ? AND service = ?',
    [username, service]
  );
  const warningCount = countRes[0]?.cnt || 0;

  let locked = false;
  let banned = false;

  if (warningCount > 3) {
    // Permanent ban
    await executeD1('UPDATE users SET banned = 1 WHERE username = ?', [username]);
    await executeD1(
      'INSERT OR REPLACE INTO bans (username, service, reason) VALUES (?, ?, ?)',
      [username, service, reason]
    );
    banned = true;
  } else {
    // 24h lockout
    const lockUntil = Math.floor(Date.now() / 1000) + 24 * 3600;
    await executeD1('UPDATE users SET locked_until = ? WHERE username = ?', [lockUntil, username]);
    locked = true;
  }

  // 3. Stop running instances
  await executeD1("UPDATE instances SET status = 'offline' WHERE username = ?", [username]);

  return { warningCount, locked, banned };
}
