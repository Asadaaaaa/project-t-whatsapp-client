import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { SyncService } from '../services/sync.service.js';
import { MessageHandler } from '../handlers/message.handler.js';

export class SingleWhatsAppClient {
  constructor(sessionId, userId = null, manager) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.manager = manager;
    this.mainApiUrl = process.env.MAIN_API_URL || 'http://localhost:4000';
    this.status = 'disconnected'; // disconnected, connecting, authenticated, connected
    this.qrCode = null;
    this.qrDataUrl = null;
    this.clientInfo = null;
    this.client = null;

    this.syncService = new SyncService(this);
    this.messageHandler = new MessageHandler(this);
  }

  async notifyMainApiSession(status, phoneNumber = null) {
    try {
      await axios.post(
        `${this.mainApiUrl}/api/whatsapp/internal/session-update`,
        {
          sessionId: this.sessionId,
          status,
          phoneNumber,
          userId: this.userId
        },
        { timeout: 3000 }
      );
    } catch (err) {
      console.error(`[WhatsAppClient:${this.sessionId}] Failed to notify session update:`, err.message);
    }
  }

  async injectFixes() {
    try {
      if (!this.client?.pupPage) return;
      await this.client.pupPage.evaluate(() => {
        if (window.WWebJS) {
          window.WWebJS.getChats = async () => {
            try {
              const ChatCollection = window.require('WAWebCollections')?.Chat;
              if (!ChatCollection) return [];
              const chats = ChatCollection.getModelsArray() || [];
              const results = [];
              for (const chat of chats) {
                try {
                  const id = chat.id?._serialized || '';
                  if (
                    id &&
                    !id.endsWith('@newsletter') &&
                    !id.endsWith('@broadcast') &&
                    id !== 'status@broadcast'
                  ) {
                    const model = await window.WWebJS.getChatModel(chat);
                    if (model) results.push(model);
                  }
                } catch (e) {
                  // Ignore individual serialization errors
                }
              }
              return results;
            } catch (e) {
              console.error('getChats override error:', e);
              return [];
            }
          };
        }
      });
      console.log(`[WhatsAppClient:${this.sessionId}] Successfully injected getChats safety patch`);
    } catch (err) {
      console.warn(`[WhatsAppClient:${this.sessionId}] Failed to inject patch:`, err.message);
    }
  }

  async start(userId = null) {
    if (userId) this.userId = userId;

    if (this.client && this.status === 'connected') {
      console.log(`[WhatsAppClient:${this.sessionId}] Already running and connected:`, this.clientInfo?.wid?.user);
      return { success: true, status: this.status, phoneNumber: this.clientInfo?.wid?.user };
    }

    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {}
      this.client = null;
    }

    this.status = 'connecting';
    this.qrCode = null;
    this.qrDataUrl = null;

    console.log(`[WhatsAppClient:${this.sessionId}] Initializing WhatsApp Web Client...`);

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth',
        clientId: this.sessionId
      }),
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js',
      },
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions'
        ]
      }
    });

    this.client.on('qr', async (qr) => {
      console.log(`[WhatsAppClient:${this.sessionId}] QR Received`);
      this.status = 'connecting';
      this.qrCode = qr;
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error(`[WhatsAppClient:${this.sessionId}] Error generating QR Data URL:`, e);
      }
      this.notifyMainApiSession('connecting');
    });

    this.client.on('authenticated', () => {
      console.log(`[WhatsAppClient:${this.sessionId}] Authenticated successfully`);
      this.status = 'authenticated';
      this.qrCode = null;
      this.qrDataUrl = null;
      this.notifyMainApiSession('authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      console.error(`[WhatsAppClient:${this.sessionId}] Auth failure:`, msg);
      this.status = 'disconnected';
      this.notifyMainApiSession('disconnected');
    });

    this.client.on('ready', async () => {
      console.log(`[WhatsAppClient:${this.sessionId}] Client is ready!`);
      this.status = 'connected';
      this.clientInfo = this.client.info;
      const phoneNumber = this.client.info?.wid?.user || null;
      console.log(`[WhatsAppClient:${this.sessionId}] Connected Phone Number:`, phoneNumber);

      await this.notifyMainApiSession('connected', phoneNumber);
      await this.injectFixes();
      // On-demand date sync is triggered during summary generation instead of automatic full sync on login
    });

    this.client.on('message_create', (msg) => {
      this.messageHandler.handle(msg);
    });

    this.client.on('disconnected', (reason) => {
      console.log(`[WhatsAppClient:${this.sessionId}] Client disconnected:`, reason);
      this.status = 'disconnected';
      this.clientInfo = null;
      this.qrCode = null;
      this.qrDataUrl = null;
      this.notifyMainApiSession('disconnected');
    });

    try {
      await this.client.initialize();
      return { success: true, status: this.status };
    } catch (err) {
      console.error(`[WhatsAppClient:${this.sessionId}] Initialization error:`, err.message);
      this.status = 'disconnected';
      this.notifyMainApiSession('disconnected');
      return { success: false, error: err.message };
    }
  }

  async stop() {
    this.status = 'disconnected';
    this.qrCode = null;
    this.qrDataUrl = null;
    this.clientInfo = null;

    if (this.client) {
      try {
        await this.client.logout();
      } catch (e) {}
      try {
        await this.client.destroy();
      } catch (e) {}
      this.client = null;
    }

    try {
      const sessionPath = path.join('./.wwebjs_auth', `session-${this.sessionId}`);
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
    } catch (e) {}

    await this.notifyMainApiSession('disconnected');
    return { success: true };
  }

  getStatus() {
    return {
      status: this.status,
      sessionId: this.sessionId,
      hasQR: !!this.qrDataUrl,
      phoneNumber: this.clientInfo?.wid?.user || null,
      pushname: this.clientInfo?.pushname || null
    };
  }

  getQR() {
    return {
      status: this.status,
      sessionId: this.sessionId,
      qr: this.qrCode,
      qrDataUrl: this.qrDataUrl
    };
  }
}

export class MultiWhatsAppManager {
  constructor() {
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

  async stopClient(sessionId = 'default') {
    const client = this.getClient(sessionId, null, false);
    if (!client) return { success: true };
    return client.stop();
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
    if (!fs.existsSync(authDir)) return;

    const mainApiUrl = process.env.MAIN_API_URL || 'http://localhost:4000';
    let dbSessions = null;

    // Fetch valid registered sessions from Controller DB
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const resp = await axios.get(`${mainApiUrl}/api/whatsapp/internal/active-sessions`, { timeout: 3000 });
        if (resp.data && Array.isArray(resp.data.data)) {
          dbSessions = resp.data.data;
          break;
        }
      } catch (err) {
        console.warn(`[MultiWhatsAppManager] Waiting for Main API to verify DB sessions (attempt ${attempt}/4)...`);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    const validSessionIds = new Set(dbSessions ? dbSessions.map(s => s.session_id) : []);
    console.log(`[MultiWhatsAppManager] DB check complete. Valid registered sessions in DB (${validSessionIds.size}):`, [...validSessionIds]);

    try {
      const entries = fs.readdirSync(authDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('session-')) {
          const sessionId = entry.name.replace('session-', '');
          const sessionPath = path.join(authDir, entry.name);

          // If session is NOT in database, PURGE it from disk!
          if (dbSessions !== null && !validSessionIds.has(sessionId)) {
            console.log(`[MultiWhatsAppManager] 🗑️  Purging orphan disk session '${sessionId}' (not found in DB after reset)...`);
            try {
              fs.rmSync(sessionPath, { recursive: true, force: true });
              console.log(`[MultiWhatsAppManager] Purged orphan session directory: ${sessionPath}`);
            } catch (rmErr) {
              console.error(`[MultiWhatsAppManager] Failed to delete orphan folder ${sessionPath}:`, rmErr.message);
            }
            continue;
          }

          // Otherwise restore valid session
          let userId = null;
          if (sessionId.startsWith('user_')) {
            userId = Number(sessionId.replace('user_', '')) || null;
          }
          console.log(`[MultiWhatsAppManager] Restoring valid DB session: ${sessionId}`);
          const client = this.getClient(sessionId, userId, true);
          client.start(userId).catch((err) => {
            console.error(`[MultiWhatsAppManager] Failed to restore session ${sessionId}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('[MultiWhatsAppManager] Error during auto-restore:', err.message);
    }
  }
}
