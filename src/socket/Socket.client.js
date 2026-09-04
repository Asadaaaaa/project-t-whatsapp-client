import { io } from 'socket.io-client';
import { LoggerHelper as sendLogs } from '#helpers';

class SocketClient {
  constructor(app) {
    this.app = app;
    this.sendLogs = sendLogs;
    this.socket = null;
    this.controllerUrl = process.env.CONTROLLER_SOCKET_URL || process.env.MAIN_API_URL || 'http://localhost:4000';
    this.isConnected = false;

    this.connect();
  }

  connect() {
    this.sendLogs(`Connecting to Controller Socket at ${this.controllerUrl}...`);

    this.socket = io(this.controllerUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      query: {
        type: 'whatsapp_worker'
      }
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      this.sendLogs(`✅ Connected to Controller Socket server (ID: ${this.socket.id})`);
      if (this.app?.onSocketConnected) {
        this.app.onSocketConnected();
      }
    });

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      this.sendLogs(`⚠️ Disconnected from Controller Socket: ${reason}`);
    });

    this.socket.on('connect_error', (err) => {
      this.sendLogs(`❌ Socket connection error: ${err.message}`);
    });

    this.registerCommandListeners();
  }

  registerCommandListeners() {
    // 1. Get Status
    this.socket.on('whatsapp:get_status', (data, callback) => {
      const sessionId = data?.sessionId || 'default';
      const status = this.app.manager.getStatus(sessionId);
      if (typeof callback === 'function') {
        callback({ success: true, data: status });
      }
    });

    // 2. Get QR Code
    this.socket.on('whatsapp:get_qr', (data, callback) => {
      const sessionId = data?.sessionId || 'default';
      const qrData = this.app.manager.getQR(sessionId);
      if (typeof callback === 'function') {
        callback({ success: true, data: qrData });
      }
    });

    // 3. Connect WhatsApp Session
    this.socket.on('whatsapp:connect', async (data, callback) => {
      const sessionId = data?.sessionId || 'default';
      const userId = data?.userId || null;
      this.sendLogs(`Received connect command for session ${sessionId} (userId: ${userId})`);

      // Start client in background
      this.app.manager.startClient(sessionId, userId).catch((err) => {
        this.sendLogs(`[Session:${sessionId}] Start client error: ${err.message}`);
      });

      if (typeof callback === 'function') {
        callback({
          success: true,
          message: `Connecting WhatsApp for session ${sessionId}...`,
          data: { sessionId }
        });
      }
    });

    // 4. Disconnect WhatsApp Session
    this.socket.on('whatsapp:disconnect', async (data, callback) => {
      const sessionId = data?.sessionId || 'default';
      this.sendLogs(`Received disconnect command for session ${sessionId}`);

      try {
        const result = await this.app.manager.stopClient(sessionId);
        if (typeof callback === 'function') {
          callback({ success: true, data: result });
        }
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // 5. Sync Specific Date Range
    this.socket.on('whatsapp:sync_date', async (data, callback) => {
      const { sessionId = 'default', date, userId = null } = data || {};
      if (!date) {
        if (typeof callback === 'function') {
          return callback({ success: false, error: 'Date is required' });
        }
        return;
      }

      this.sendLogs(`Received sync_date command for session ${sessionId} on date ${date}`);
      const client = this.app.manager.getClient(sessionId, userId, false);
      if (!client) {
        if (typeof callback === 'function') {
          return callback({ success: false, error: `Session ${sessionId} is not active` });
        }
        return;
      }

      try {
        const result = await client.syncService.syncDateRange(date);
        if (typeof callback === 'function') {
          callback({ success: true, data: result });
        }
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });
  }

  /**
   * Emit session status change to Controller
   */
  async emitSessionUpdate(payload) {
    if (!this.socket || !this.isConnected) {
      this.sendLogs(`Cannot emit session_update (Socket not connected)`);
      return;
    }
    return new Promise((resolve) => {
      this.socket.emit('whatsapp:session_updated', payload, (res) => {
        resolve(res);
      });
    });
  }

  /**
   * Emit QR code change to Controller
   */
  async emitQRUpdate(payload) {
    if (!this.socket || !this.isConnected) {
      return;
    }
    return new Promise((resolve) => {
      this.socket.emit('whatsapp:qr_updated', payload, (res) => {
        resolve(res);
      });
    });
  }

  /**
   * Emit real-time incoming message to Controller
   */
  async emitIncomingMessage(payload) {
    if (!this.socket || !this.isConnected) {
      this.sendLogs(`Cannot emit incoming_message (Socket not connected)`);
      return;
    }
    return new Promise((resolve) => {
      this.socket.emit('whatsapp:incoming_message', payload, (res) => {
        resolve(res);
      });
    });
  }

  /**
   * Emit sync batch messages to Controller
   */
  async emitSyncBatch(payload) {
    if (!this.socket || !this.isConnected) {
      this.sendLogs(`Cannot emit sync_batch (Socket not connected)`);
      return;
    }
    return new Promise((resolve) => {
      this.socket.emit('whatsapp:sync_batch', payload, (res) => {
        resolve(res);
      });
    });
  }

  /**
   * Emit detected reimbursement to Controller for storage and Gemini analysis
   */
  async emitReimbursementDetected(payload) {
    if (!this.socket || !this.isConnected) {
      this.sendLogs(`Cannot emit reimbursement_detected (Socket not connected)`);
      return { success: false, error: 'Socket not connected' };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ success: false, error: 'Socket timeout waiting for reimbursement ack' });
      }, 30000);

      this.socket.emit('whatsapp:reimbursement_detected', payload, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  /**
   * Fetch active registered sessions from Controller DB
   */
  async fetchActiveSessions() {
    if (!this.socket || !this.isConnected) return null;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, 5000);

      this.socket.emit('whatsapp:get_db_sessions', {}, (response) => {
        clearTimeout(timer);
        if (response && response.success && Array.isArray(response.data)) {
          resolve(response.data);
        } else {
          resolve(null);
        }
      });
    });
  }
}

export default SocketClient;
