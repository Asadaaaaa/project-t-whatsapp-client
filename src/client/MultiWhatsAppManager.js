import fs from 'fs';
import path from 'path';
import SingleWhatsAppClient from './SingleWhatsAppClient.js';
import { LoggerHelper as sendLogs } from '#helpers';

export class MultiWhatsAppManager {
  constructor(app) {
    this.app = app;
    this.sendLogs = sendLogs;
    this.clients = new Map(); // sessionId -> SingleWhatsAppClient
  }

  getClient(sessionId = 'default', userId = null, autoCreate = true) {
    if (!this.clients.has(sessionId)) {
      if (!autoCreate) return null;
      const client = new SingleWhatsAppClient(sessionId, userId, this);
      this.clients.set(sessionId, client);
    } else if (userId && !this.clients.get(sessionId).userId) {
      this.clients.get(sessionId).userId = userId;
    }
    return this.clients.get(sessionId);
  }

  async startClient(sessionId = 'default', userId = null) {
    const client = this.getClient(sessionId, userId, true);
    return client.start(userId);
  }

  async stopClient(sessionId = 'default', clean = false) {
    const client = this.getClient(sessionId, null, false);
    if (!client) return { success: true };
    const res = await client.stop(clean);
    this.clients.delete(sessionId);
    return res;
  }

  getStatus(sessionId = 'default') {
    const client = this.getClient(sessionId, null, false);
    if (!client) {
      return {
        status: 'disconnected',
        sessionId,
        hasQR: false,
        phoneNumber: null,
        pushname: null
      };
    }
    return client.getStatus();
  }

  getQR(sessionId = 'default') {
    const client = this.getClient(sessionId, null, false);
    if (!client) {
      return {
        status: 'disconnected',
        sessionId,
        qr: null,
        qrDataUrl: null
      };
    }
    return client.getQR();
  }

  async autoRestoreAllSessions() {
    const authDir = './.wwebjs_auth';
    if (!fs.existsSync(authDir)) {
      this.sendLogs('No saved sessions directory (.wwebjs_auth) found. Worker is ready and waiting for Controller commands.');
      return;
    }

    this.sendLogs(`Verifying registered sessions with Controller DB via Socket.IO...`);
    let dbSessions = null;

    for (let attempt = 1; attempt <= 4; attempt++) {
      dbSessions = await this.app.socketClient.fetchActiveSessions();
      if (dbSessions !== null) break;
      this.sendLogs(`Waiting for Controller to return DB sessions (attempt ${attempt}/4)...`);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const validSessionIds = new Set(dbSessions ? dbSessions.map((s) => s.session_id) : []);
    this.sendLogs(`DB check complete. Valid registered sessions in DB (${validSessionIds.size}): ${JSON.stringify([...validSessionIds])}`);

    try {
      const entries = fs.readdirSync(authDir, { withFileTypes: true });
      let restoredCount = 0;
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('session-')) {
          const sessionId = entry.name.replace('session-', '');
          const sessionPath = path.join(authDir, entry.name);

          // Restore valid session
          let userId = null;
          if (sessionId.startsWith('user_')) {
            userId = Number(sessionId.replace('user_', '')) || null;
          }
          this.sendLogs(`Restoring saved session: ${sessionId}`);
          restoredCount++;
          const client = this.getClient(sessionId, userId, true);
          client.start(userId).catch((err) => {
            this.sendLogs(`Failed to restore session ${sessionId}: ${err.message}`);
          });
        }
      }
      this.sendLogs(`Auto-restore complete (${restoredCount} session(s) restored). Worker is ready and waiting for commands.`);
    } catch (err) {
      this.sendLogs(`Error during auto-restore: ${err.message}`);
    }
  }

  async scanReimbursement() {
    this.sendLogs('[MultiWhatsAppManager] 🔍 Memulai scan riwayat reimbursement di seluruh sesi aktif...');
    let totalScanned = 0;
    const sessionResults = [];

    for (const [sessionId, client] of this.clients.entries()) {
      const canScan = (client.status === 'connected' || client.status === 'authenticated') && client.messageHandler?.reimbursementTester;
      if (canScan) {
        totalScanned++;
        const scanRes = await client.messageHandler.reimbursementTester.scanHistory();
        sessionResults.push({
          sessionId,
          status: client.status,
          phoneNumber: client.clientInfo?.wid?.user || null,
          ...scanRes
        });
      } else {
        this.sendLogs(`[MultiWhatsAppManager] Sesi '${sessionId}' status '${client.status}' (belum siap dipindai)`);
        sessionResults.push({
          sessionId,
          status: client.status,
          message: 'Client belum siap dipindai (harus authenticated atau connected)'
        });
      }
    }

    if (totalScanned === 0) {
      this.sendLogs('[MultiWhatsAppManager] ⚠️ Tidak ada sesi WhatsApp yang sedang dalam status connected.');
    }

    return {
      connectedSessionsScanned: totalScanned,
      sessions: sessionResults
    };
  }
}

export default MultiWhatsAppManager;
