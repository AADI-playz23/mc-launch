export async function queryD1(sql, params = []) {
  const { token, accountId, dbId } = getD1Credentials();
  const data = await d1Request(token, accountId, dbId, sql, params);
  return data.result[0].results;
}

export async function executeD1(sql, params = []) {
  const { token, accountId, dbId } = getD1Credentials();
  const data = await d1Request(token, accountId, dbId, sql, params);
  return data.result[0].meta;
}

// ── Internal ──

function getD1Credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DB_1_ID;

  if (!token || !accountId || !dbId) {
    throw new Error('Missing Cloudflare D1 credentials in environment variables.');
  }
  return { token, accountId, dbId };
}

async function d1Request(token, accountId, dbId, sql, params) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const data = await response.json();

  if (!data.success) {
    console.error('D1 Error:', data.errors);
    throw new Error(data.errors[0]?.message || 'Failed to execute D1 query');
  }

  return data;
}
