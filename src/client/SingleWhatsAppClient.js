import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { SyncService } from '#services';
import { MessageHandler } from '#handlers';
import { LoggerHelper as sendLogs } from '#helpers';

export class SingleWhatsAppClient {
  constructor(sessionId, userId = null, manager) {
    this.sessionId = sessionId;
    this.userId = userId;
    this.manager = manager;
    this.sendLogs = sendLogs;
    this.status = 'disconnected'; // disconnected, connecting, authenticated, connected
    this.qrCode = null;
    this.qrDataUrl = null;
    this.clientInfo = null;
    this.client = null;

    this.syncService = new SyncService(this);
    this.messageHandler = new MessageHandler(this);
  }

  async notifySessionUpdate(status, phoneNumber = null) {
    this.status = status;
    const socketClient = this.manager?.app?.socketClient;
    if (socketClient) {
      await socketClient.emitSessionUpdate({
        sessionId: this.sessionId,
        status,
        phoneNumber,
        userId: this.userId
      });
    }
  }

  async notifyQRUpdate(qr = null, qrDataUrl = null) {
    this.qrCode = qr;
    this.qrDataUrl = qrDataUrl;
    const socketClient = this.manager?.app?.socketClient;
    if (socketClient) {
      await socketClient.emitQRUpdate({
        sessionId: this.sessionId,
        qr,
        qrDataUrl,
        userId: this.userId
      });
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
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Injected getChats safety patch`);
    } catch (err) {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Failed to inject patch: ${err.message}`);
    }
  }

  async handleDetachedFrame(source = '') {
    this.sendLogs(`[WhatsAppClient:${this.sessionId}] ⚠️ Detached frame detected (${source}). Initiating self-healing reload...`);
    try {
      if (this.client?.pupBrowser) {
        const pages = await this.client.pupBrowser.pages();
        const waPage = pages.find((p) => p.url().includes('whatsapp.com')) || pages[0];
        if (waPage) {
          this.client.pupPage = waPage;
          await waPage.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          if (typeof this.client.inject === 'function') {
            await this.client.inject().catch(() => {});
          }
          await this.injectFixes();
          this.sendLogs(`[WhatsAppClient:${this.sessionId}] ✅ Self-healing reload completed.`);
          return true;
        }
      }
    } catch (e) {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Reload failed (${e.message}). Restarting client instance...`);
      try {
        await this.start(this.userId);
      } catch (startErr) {}
    }
    return false;
  }

  async start(userId = null) {
    if (userId) this.userId = userId;

    if (this.client && this.status === 'connected') {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Already running and connected: ${this.clientInfo?.wid?.user}`);
      return { success: true, status: this.status, phoneNumber: this.clientInfo?.wid?.user };
    }

    if (this.client) {
      try {
        await this.client.destroy();
      } catch (e) {}
      this.client = null;
    }

    // Clean up leftover lock files from previous abrupt terminations
    try {
      const sessionDir = path.join('./.wwebjs_auth', `session-${this.sessionId}`);
      if (fs.existsSync(sessionDir)) {
        const staleFiles = [
          path.join(sessionDir, 'lockfile'),
          path.join(sessionDir, 'Default', 'LOCK'),
          path.join(sessionDir, 'Default', 'SingletonLock'),
          path.join(sessionDir, 'Default', 'SingletonCookie'),
          path.join(sessionDir, 'Default', 'SingletonSocket'),
          path.join(sessionDir, 'SingletonLock'),
          path.join(sessionDir, 'SingletonCookie'),
          path.join(sessionDir, 'SingletonSocket')
        ];
        for (const f of staleFiles) {
          try {
            if (fs.existsSync(f)) {
              fs.unlinkSync(f);
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    this.status = 'connecting';
    this.qrCode = null;
    this.qrDataUrl = null;

    this.sendLogs(`[WhatsAppClient:${this.sessionId}] Initializing WhatsApp Web Client...`);

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth',
        clientId: this.sessionId
      }),
      webVersionCache: {
        type: 'none'
      },
      puppeteer: {
        headless: true,
        protocolTimeout: 120000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-session-crashed-bubble',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=IsolateOrigins,site-per-process,CalculateNativeWinOcclusion',
          '--disable-site-isolation-trials',
          '--disable-ipc-flooding-protection'
        ]
      }
    });

    this.client.on('qr', async (qr) => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] QR Received`);
      this.status = 'connecting';
      this.qrCode = qr;
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        this.sendLogs(`[WhatsAppClient:${this.sessionId}] Error generating QR Data URL: ${e.message}`);
      }
      this.notifySessionUpdate('connecting');
      this.notifyQRUpdate(qr, this.qrDataUrl);
    });

    this.client.on('authenticated', () => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Authenticated successfully`);
      this.status = 'authenticated';
      this.notifyQRUpdate(null, null);
      this.notifySessionUpdate('authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Auth failure: ${msg}`);
      this.status = 'disconnected';
      this.notifyQRUpdate(null, null);
      this.notifySessionUpdate('disconnected');
    });

    this.client.on('ready', async () => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Client is ready!`);
      this.status = 'connected';
      this.clientInfo = this.client.info;
      const phoneNumber = this.client.info?.wid?.user || null;
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Connected Phone Number: ${phoneNumber}`);

      this.notifyQRUpdate(null, null);
      await this.notifySessionUpdate('connected', phoneNumber);
      await this.injectFixes();

      // Auto-scan awal pesan lama #reimburse beberapa detik setelah siap
      setTimeout(async () => {
        try {
          if (this.status === 'connected' && this.messageHandler?.reimbursementTester) {
            await this.messageHandler.reimbursementTester.scanHistory({ quiet: false });
          }
        } catch (e) {
          this.sendLogs(`[WhatsAppClient:${this.sessionId}] Error during initial scan: ${e.message}`);
        }
      }, 3500);

      // Background scan berkala otomatis setiap 10 detik
      if (this.reimburseScanInterval) {
        clearInterval(this.reimburseScanInterval);
      }
      this.reimburseScanInterval = setInterval(async () => {
        try {
          if (this.status === 'connected' && this.messageHandler?.reimbursementTester) {
            await this.messageHandler.reimbursementTester.scanHistory({ quiet: true });
          }
        } catch (e) {}
      }, 10000);
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] ⏱️ Background scanner #reimburse aktif (berjalan setiap 10 detik)`);

      // Auto-sync semua daftar chat & grup ke Controller saat client connect
      setTimeout(async () => {
        try {
          if (this.status === 'connected') {
            const chats = await this.fetchAllChatsList();
            if (chats.length > 0 && this.manager?.app?.socketClient) {
              await this.manager.app.socketClient.emitSyncBatch({
                sessionId: this.sessionId,
                userId: this.userId,
                chats: chats.map((c) => ({
                  id: c.id,
                  name: c.name,
                  isGroup: c.isGroup,
                  phoneNumber: c.phoneNumber,
                  messages: []
                }))
              });
              this.sendLogs(`[WhatsAppClient:${this.sessionId}] 📋 Tersinkron ${chats.length} chat & grup ke Controller`);
            }
          }
        } catch (e) {
          this.sendLogs(`[WhatsAppClient:${this.sessionId}] Error sync all chats: ${e.message}`);
        }
      }, 4000);
    });

    this.client.on('message_create', (msg) => {
      this.messageHandler.handle(msg);
    });

    this.client.on('group_join', async () => {
      try {
        const chats = await this.fetchAllChatsList();
        if (chats.length > 0 && this.manager?.app?.socketClient) {
          await this.manager.app.socketClient.emitSyncBatch({
            sessionId: this.sessionId,
            userId: this.userId,
            chats: chats.map((c) => ({
              id: c.id,
              name: c.name,
              isGroup: c.isGroup,
              phoneNumber: c.phoneNumber,
              messages: []
            }))
          });
        }
      } catch (e) {}
    });

    this.client.on('group_update', async () => {
      try {
        const chats = await this.fetchAllChatsList();
        if (chats.length > 0 && this.manager?.app?.socketClient) {
          await this.manager.app.socketClient.emitSyncBatch({
            sessionId: this.sessionId,
            userId: this.userId,
            chats: chats.map((c) => ({
              id: c.id,
              name: c.name,
              isGroup: c.isGroup,
              phoneNumber: c.phoneNumber,
              messages: []
            }))
          });
        }
      } catch (e) {}
    });

    this.client.on('disconnected', (reason) => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Client disconnected: ${reason}`);
      if (this.reimburseScanInterval) {
        clearInterval(this.reimburseScanInterval);
        this.reimburseScanInterval = null;
      }
      this.status = 'disconnected';
      this.clientInfo = null;
      this.notifyQRUpdate(null, null);
      this.notifySessionUpdate('disconnected');
    });

    try {
      await this.client.initialize();
      return { success: true, status: this.status };
    } catch (err) {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Initialization error: ${err.message}`);
      this.status = 'disconnected';
      this.notifyQRUpdate(null, null);
      this.notifySessionUpdate('disconnected');
      return { success: false, error: err.message };
    }
  }

  async stop(clean = false) {
    if (this.reimburseScanInterval) {
      clearInterval(this.reimburseScanInterval);
      this.reimburseScanInterval = null;
    }
    this.status = 'disconnected';
    this.clientInfo = null;
    this.notifyQRUpdate(null, null);

    if (this.client) {
      if (clean) {
        try {
          await this.client.logout();
        } catch (e) {}
      }
      try {
        await this.client.destroy();
      } catch (e) {}
      this.client = null;
    }

    if (clean) {
      try {
        const sessionPath = path.join('./.wwebjs_auth', `session-${this.sessionId}`);
        if (fs.existsSync(sessionPath)) {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        }
      } catch (e) {}
    }

    await this.notifySessionUpdate('disconnected');
    return { success: true };
  }

  async fetchAllChatsList() {
    if (!this.client || this.status !== 'connected') {
      return [];
    }

    try {
      if (this.client.pupPage && !this.client.pupPage.isClosed()) {
        const chats = await this.client.pupPage.evaluate(() => {
          try {
            const WAWebCollections = window.require?.('WAWebCollections');
            const ChatCollection = WAWebCollections?.Chat;
            if (!ChatCollection) return [];
            const list = ChatCollection.getModelsArray ? ChatCollection.getModelsArray() : [];
            const results = [];
            for (const chat of list) {
              const id = chat.id?._serialized || '';
              if (
                id &&
                !id.endsWith('@newsletter') &&
                !id.endsWith('@broadcast') &&
                id !== 'status@broadcast'
              ) {
                const name = chat.name || chat.formattedTitle || (chat.contact ? (chat.contact.name || chat.contact.pushname) : '') || '';
                const isGroup = !!chat.isGroup;
                const phoneNumber = chat.id?.user || null;
                results.push({
                  id,
                  name: name || id,
                  isGroup,
                  phoneNumber
                });
              }
            }
            return results;
          } catch (e) {
            return [];
          }
        });

        if (Array.isArray(chats) && chats.length > 0) {
          return chats;
        }
      }

      const rawChats = await this.client.getChats();
      return (rawChats || []).map((c) => ({
        id: c.id?._serialized || '',
        name: c.name || c.formattedTitle || '',
        isGroup: !!c.isGroup,
        phoneNumber: c.id?.user || null
      })).filter((c) => c.id && !c.id.endsWith('@newsletter') && !c.id.endsWith('@broadcast'));
    } catch (err) {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Error fetching chats list: ${err.message}`);
      return [];
    }
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

export default SingleWhatsAppClient;
