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
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] QR Received`);
      this.status = 'connecting';
      this.qrCode = qr;
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        this.sendLogs(`[WhatsAppClient:${this.sessionId}] Error generating QR Data URL: ${e.message}`);
      }
      this.notifySessionUpdate('connecting');
    });

    this.client.on('authenticated', () => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Authenticated successfully`);
      this.status = 'authenticated';
      this.qrCode = null;
      this.qrDataUrl = null;
      this.notifySessionUpdate('authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Auth failure: ${msg}`);
      this.status = 'disconnected';
      this.notifySessionUpdate('disconnected');
    });

    this.client.on('ready', async () => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Client is ready!`);
      this.status = 'connected';
      this.clientInfo = this.client.info;
      const phoneNumber = this.client.info?.wid?.user || null;
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Connected Phone Number: ${phoneNumber}`);

      await this.notifySessionUpdate('connected', phoneNumber);
      await this.injectFixes();
    });

    this.client.on('message_create', (msg) => {
      this.messageHandler.handle(msg);
    });

    this.client.on('disconnected', (reason) => {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Client disconnected: ${reason}`);
      this.status = 'disconnected';
      this.clientInfo = null;
      this.qrCode = null;
      this.qrDataUrl = null;
      this.notifySessionUpdate('disconnected');
    });

    try {
      await this.client.initialize();
      return { success: true, status: this.status };
    } catch (err) {
      this.sendLogs(`[WhatsAppClient:${this.sessionId}] Initialization error: ${err.message}`);
      this.status = 'disconnected';
      this.notifySessionUpdate('disconnected');
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

    await this.notifySessionUpdate('disconnected');
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

export default SingleWhatsAppClient;
