import dotenv from 'dotenv';
dotenv.config();

import { MultiWhatsAppManager } from './client/whatsapp.client.js';
import { createServer } from './api/server.js';

const PORT = process.env.PORT || 4001;

const manager = new MultiWhatsAppManager();
const app = createServer(manager);

app.listen(PORT, () => {
  console.log(`[WhatsAppService] Multi-Client WhatsApp API listening on http://0.0.0.0:${PORT}`);

  // Auto restore all saved user sessions on startup
  manager.autoRestoreAllSessions().catch((err) => {
    console.error('[WhatsAppService] Error during auto-restore:', err?.message || err);
  });
});
