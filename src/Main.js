import * as dotenv from 'dotenv';
import fs from 'fs';
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

    // 3. Graceful process termination
    process.on('SIGINT', async () => {
      this.sendLogs('SIGINT received. Shutting down worker...');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      this.sendLogs('SIGTERM received. Shutting down worker...');
      process.exit(0);
    });
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
new WorkerApp();
