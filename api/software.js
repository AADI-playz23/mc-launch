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
    
    // Extract only the version names, explicitly keeping URLs secret
    const versions = parsed.versions ? Object.keys(parsed.versions) : [];
    
    return res.status(200).json({
      status: "success",
      latest: parsed.latest,
      versions: versions
    });
  } catch (e) {
    return res.status(404).json({ status: "error", message: "Software not found" });
  }
}
