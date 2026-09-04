import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { LoggerHelper as sendLogs } from '#helpers';
import { MultiWhatsAppManager } from '#client';
import { SocketClient } from '#socket';

class WorkerApp {
  constructor() {
    this.sendLogs = sendLogs;
    this.hasAutoRestored = false;

    dotenv.config();
    this.env = process.env;

    this.sendLogs('Initializing WhatsApp Worker Service (OOP Socket.IO Client)...');

    this.init();
  }

  init() {
    // 1. Initialize WhatsApp Multi-session Manager
    this.manager = new MultiWhatsAppManager(this);

    // 2. Initialize Socket.IO Client connection to Controller
    this.socketClient = new SocketClient(this);

    // 3. Initialize lightweight HTTP status server
    this.initHttpServer();

    // 4. Global exception handlers to catch transient Puppeteer / WhatsApp Web navigation errors
    process.on('unhandledRejection', (reason) => {
      const msg = reason?.message || String(reason);
      if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Session closed') ||
        msg.includes('Protocol error') ||
        msg.includes('detached Frame')
      ) {
        this.sendLogs(`⚠️ [Ignored Transient Puppeteer Event] ${msg}`);
        return;
      }
      this.sendLogs(`⚠️ [Unhandled Rejection] ${reason?.stack || msg}`);
    });

    process.on('uncaughtException', (err) => {
      const msg = err?.message || String(err);
      if (
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target closed') ||
        msg.includes('Session closed') ||
        msg.includes('Protocol error') ||
        msg.includes('detached Frame')
      ) {
        this.sendLogs(`⚠️ [Ignored Transient Puppeteer Error] ${msg}`);
        return;
      }
      this.sendLogs(`❌ [Uncaught Exception] ${err?.stack || msg}`);
    });

    // 5. Graceful process termination
    process.on('SIGINT', async () => {
      this.sendLogs('SIGINT received. Shutting down worker...');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      this.sendLogs('SIGTERM received. Shutting down worker...');
      process.exit(0);
    });
  }

  initHttpServer() {
    const app = express();
    const port = process.env.WORKER_HTTP_PORT || 3050;

    app.get('/status', (req, res) => {
      const results = [];
      for (const [id, client] of this.manager.clients.entries()) {
        results.push({
          sessionId: id,
          status: client.status,
          hasClient: Boolean(client.client),
          hasQR: Boolean(client.qrDataUrl),
          qr: client.qrCode,
          phoneNumber: client.clientInfo?.wid?.user || null
        });
      }
      res.json({
        success: true,
        socketConnected: this.socketClient?.isConnected,
        clients: results
      });
    });

    app.get(['/scan', '/rescan'], async (req, res) => {
      try {
        for (const client of this.manager.clients.values()) {
          if (client.messageHandler?.reimbursementTester) {
            client.messageHandler.reimbursementTester.processedMsgIds.clear();
          }
        }
        const result = await this.manager.scanReimbursement();
        res.json({ success: true, ...result });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });


    try {
      this.httpServer = app.listen(port, () => {
        this.sendLogs(`🚀 [HTTP Trigger Server] Siap di http://localhost:${port}/scan`);
      });
      this.httpServer.on('error', (err) => {
        this.sendLogs(`[HTTP Trigger Server] Port ${port} busy or error: ${err.message}`);
      });
    } catch (e) {
      this.sendLogs(`[HTTP Trigger Server] Gagal start: ${e.message}`);
    }
  }

  /**
   * Triggered when Socket.IO successfully establishes connection with the Controller
   */
  async onSocketConnected() {
    if (!this.hasAutoRestored) {
      this.hasAutoRestored = true;
      this.sendLogs('Auto-restoring saved WhatsApp sessions...');
      this.manager.autoRestoreAllSessions().catch((err) => {
        this.sendLogs(`Error during auto-restore: ${err?.message || err}`);
      });
    }
  }
}

export default WorkerApp;
// WorkerApp instance entry
new WorkerApp();
