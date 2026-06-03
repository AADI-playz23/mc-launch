export async function queryD1(sql, params = []) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DB_1_ID;

  if (!token || !accountId || !dbId) {
    throw new Error("Missing Cloudflare D1 credentials in environment variables.");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql: sql,
      params: params
    })
  });

  const data = await response.json();

  if (!data.success) {
    console.error("D1 Error:", data.errors);
    throw new Error(data.errors[0]?.message || "Failed to execute D1 query");
  }

  // D1 returns an array of results for each query statement
  // We typically just return the first result's rows
  return data.result[0].results;
}

export async function executeD1(sql, params = []) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DB_1_ID;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql: sql,
      params: params
    })
  });

  const data = await response.json();
  if (!data.success) {
    console.error("D1 Error:", data.errors);
    throw new Error(data.errors[0]?.message || "Failed to execute D1 query");
  }
  return data.result[0].meta; // Returns execution metadata (e.g. rows_written)
}
