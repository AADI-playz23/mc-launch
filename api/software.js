import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const { type } = req.query;
  if (!type) {
    return res.status(400).json({ status: "error", message: "Software type required" });
  }

  try {
    const filePath = path.join(process.cwd(), 'api', '_data', `${type}.json`);
    const fileData = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(fileData);
    
    // Support both paper.json format (has 'versions' object) and fabric.json format (flat object)
    let versions = [];
    if (parsed.versions) {
      versions = Object.keys(parsed.versions);
    } else {
      versions = Object.keys(parsed).filter(k => k !== 'latest');
    }
    
    return res.status(200).json({
      status: "success",
      latest: parsed.latest || versions[0], // fallback to first item if no latest
      versions: versions
    });
  } catch (e) {
    return res.status(404).json({ status: "error", message: "Software not found" });
  }
}
