import { queryD1 } from './_lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const diagnostics = {
    environment_variables: {
      CLOUDFLARE_API_TOKEN: !!process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: !!process.env.CLOUDFLARE_ACCOUNT_ID,
      D1_DB_1_ID: !!process.env.D1_DB_1_ID,
      ABSORA_PAT: !!process.env.ABSORA_PAT,
      JWT_SECRET: !!process.env.JWT_SECRET,
      WORKER_SECRET: !!process.env.WORKER_SECRET,
    },
    database_connection: 'pending',
    github_auth: 'pending'
  };

  // 1. Test Database Connection
  try {
    if (diagnostics.environment_variables.CLOUDFLARE_API_TOKEN) {
      await queryD1("SELECT 1 AS ok");
      diagnostics.database_connection = 'success';
    } else {
      diagnostics.database_connection = 'skipped (missing credentials)';
    }
  } catch (e) {
    diagnostics.database_connection = `failed: ${e.message}`;
  }

  // 2. Test GitHub Token validity (without triggering action)
  try {
    if (diagnostics.environment_variables.ABSORA_PAT) {
      const ghRes = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${process.env.ABSORA_PAT}`,
          'User-Agent': 'AbsoraCloud-Diagnostic'
        }
      });
      if (ghRes.ok) {
        const ghUser = await ghRes.json();
        diagnostics.github_auth = `success (Logged in as ${ghUser.login})`;
      } else {
        diagnostics.github_auth = `failed (Invalid Token: ${ghRes.status})`;
      }
    } else {
      diagnostics.github_auth = 'skipped (missing ABSORA_PAT)';
    }
  } catch (e) {
    diagnostics.github_auth = `failed: ${e.message}`;
  }

  return res.status(200).json({
    status: 'success',
    diagnostics
  });
}
