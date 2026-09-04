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

      // Sync Contact Exceptions from Controller
      this.fetchContactExceptions().then((exceptions) => {
        if (exceptions && this.app?.manager?.setContactExceptions) {
          this.app.manager.setContactExceptions(exceptions);
        }
      }).catch(() => {});
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
        const result = await this.app.manager.stopClient(sessionId, true);
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

    // 6. Send Message to WhatsApp Chat (Group or Contact)
    this.socket.on('whatsapp:send_message', async (data, callback) => {
      const { sessionId = 'default', chatId, message, userId = null } = data || {};
      if (!chatId || !message) {
        if (typeof callback === 'function') {
          return callback({ success: false, error: 'chatId and message are required' });
        }
        return;
      }

      this.sendLogs(`Received send_message command for session ${sessionId} to ${chatId}`);
      const clientObj = this.app.manager.getClient(sessionId, userId, false);
      if (!clientObj || !clientObj.client || clientObj.status !== 'connected') {
        this.sendLogs(`Cannot send message: session ${sessionId} not active or not connected`);
        if (typeof callback === 'function') {
          return callback({ success: false, error: `WhatsApp session ${sessionId} is not connected` });
        }
        return;
      }

      try {
        let sent;
        try {
          sent = await clientObj.client.sendMessage(chatId, message);
        } catch (sendErr) {
          if (sendErr?.message && sendErr.message.includes('detached Frame')) {
            this.sendLogs(`⚠️ Detached frame detected during sendMessage. Triggering self-healing...`);
            await clientObj.handleDetachedFrame('sendMessage');
            sent = await clientObj.client.sendMessage(chatId, message);
          } else {
            throw sendErr;
          }
        }
        this.sendLogs(`✅ WhatsApp message successfully sent to ${chatId} (ID: ${sent?.id?._serialized})`);
        if (typeof callback === 'function') {
          callback({ success: true, data: { id: sent?.id?._serialized || null } });
        }
      } catch (err) {
        this.sendLogs(`❌ Failed to send WhatsApp message to ${chatId}: ${err.message}`);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    });

    // 7. Get Live Chats & Groups directly from WhatsApp Web client
    this.socket.on('whatsapp:get_chats', async (data, callback) => {
      const { sessionId = 'default', userId = null } = data || {};
      const clientObj = this.app.manager.getClient(sessionId, userId, false);
      if (!clientObj || !clientObj.client || clientObj.status !== 'connected') {
        if (typeof callback === 'function') {
          return callback({ success: false, error: 'Client not connected', data: [] });
        }
        return;
      }

      try {
        let chats = [];
        try {
          chats = await clientObj.fetchAllChatsList();
        } catch (fetchErr) {
          if (fetchErr?.message && fetchErr.message.includes('detached Frame')) {
            this.sendLogs(`⚠️ Detached frame detected during get_chats. Triggering self-healing...`);
            await clientObj.handleDetachedFrame('get_chats');
            chats = await clientObj.fetchAllChatsList();
          } else {
            throw fetchErr;
          }
        }
        this.sendLogs(`[Session:${sessionId}] Fetched ${chats.length} live chats/groups for Controller`);
        if (typeof callback === 'function') {
          callback({ success: true, data: chats });
        }
      } catch (err) {
        this.sendLogs(`[Session:${sessionId}] Error fetching live chats: ${err.message}`);
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message, data: [] });
        }
      }
    });

    // 8. Real-time Contact Exceptions update from Controller
    this.socket.on('whatsapp:contact_exceptions_updated', (data) => {
      const list = data?.excludedChatIds || [];
      this.sendLogs(`[SocketClient] 📋 Received updated contact exceptions list (${list.length} items)`);
      if (this.app?.manager?.setContactExceptions) {
        this.app.manager.setContactExceptions(list);
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

  /**
   * Fetch active contact exceptions from Controller DB
   */
  async fetchContactExceptions() {
    if (!this.socket || !this.isConnected) return null;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve([]);
      }, 5000);

      this.socket.emit('whatsapp:get_contact_exceptions', {}, (response) => {
        clearTimeout(timer);
        if (response && response.success && Array.isArray(response.data)) {
          resolve(response.data);
        } else {
          resolve([]);
        }
      });
    });
  }
}

export default SocketClient;
