import { sendSuccess, sendError, validateBody } from './_lib/middleware.js';
import fetch from 'node-fetch'; // Vercel has fetch globally in modern Node, but import is fine

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { q = '', software = 'paper' } = req.query;
    
    // Modrinth API
    const modrinthSoftware = software.toLowerCase() === 'paper' ? 'paper' : 
                             software.toLowerCase() === 'fabric' ? 'fabric' : 'forge';

    try {
      const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=[["categories:${modrinthSoftware}"]]`;
      const response = await fetch(url);
      const data = await response.json();

      return sendSuccess(res, { plugins: data.hits });
    } catch (error) {
      console.error("Plugins API Error:", error);
      return sendError(res, 500, "Failed to fetch plugins from Modrinth");
    }
  }

  return sendError(res, 405, 'Method not allowed');
}
