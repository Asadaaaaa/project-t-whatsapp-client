import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function cleanupOrphanedPuppeteer(sendLogs = console.log) {
  try {
    // Only kill chrome processes originating from puppeteer's cache directory
    const output = execSync('powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -match \'puppeteer\' } | Select-Object -ExpandProperty Id"', {
      encoding: 'utf8'
    });

    const pids = output
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => /^\d+$/.test(p));

    if (pids.length > 0) {
      sendLogs(`[Cleanup] Menemukan ${pids.length} proses Chrome Puppeteer yatim piatu. Membersihkan...`);
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid} >nul 2>&1`);
        } catch (e) {}
      }
      sendLogs(`[Cleanup] ✅ ${pids.length} proses Chrome lama berhasil dihentikan.`);
    }
  } catch (err) {
    // Ignore if powershell or taskkill has no results
  }

  // Remove stale lock files in .wwebjs_auth
  const authDir = './.wwebjs_auth';
  if (fs.existsSync(authDir)) {
    try {
      const cleanDirLocks = (dir) => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = path.join(dir, item.name);
          if (item.isDirectory()) {
            cleanDirLocks(fullPath);
          } else if (
            item.name === 'lockfile' ||
            item.name === 'LOCK' ||
            item.name.startsWith('Singleton')
          ) {
            try {
              fs.unlinkSync(fullPath);
              sendLogs(`[Cleanup] 🔓 Menghapus stale lock file: ${fullPath}`);
            } catch (e) {}
          }
        }
      };
      cleanDirLocks(authDir);
    } catch (e) {}
  }
}

export default cleanupOrphanedPuppeteer;
