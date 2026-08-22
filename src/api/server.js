import express from 'express';
import cors from 'cors';

export function createServer(manager) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Helper to extract sessionId from query or body (defaults to 'default')
  const getSessionId = (req) => {
    return req.query.sessionId || req.body.sessionId || (req.body.userId ? `user_${req.body.userId}` : 'default');
  };

  app.get('/status', (req, res) => {
    const sessionId = getSessionId(req);
    return res.json({
      status: 200,
      data: manager.getStatus(sessionId)
    });
  });

  app.get('/qr', (req, res) => {
    const sessionId = getSessionId(req);
    return res.json({
      status: 200,
      data: manager.getQR(sessionId)
    });
  });

  app.post('/connect', async (req, res) => {
    const sessionId = getSessionId(req);
    const { userId } = req.body;

    manager.startClient(sessionId, userId).catch((err) => {
      console.error(`[API:${sessionId}] Connect error:`, err);
    });

    return res.json({
      status: 200,
      message: `Connecting WhatsApp for session ${sessionId}...`,
      data: { sessionId }
    });
  });

  app.post('/disconnect', async (req, res) => {
    const sessionId = getSessionId(req);
    const result = await manager.stopClient(sessionId);

    return res.json({
      status: 200,
      message: `Session ${sessionId} disconnected`,
      data: result
    });
  });

  app.post('/sync', async (req, res) => {
    const sessionId = getSessionId(req);
    const client = manager.getClient(sessionId, null, false);
    if (!client) {
      return res.status(400).json({ status: 400, message: `Session ${sessionId} not found or active` });
    }

    client.syncService.performInitialSync(7).catch((err) => {
      console.error(`[API:${sessionId}] Sync error:`, err);
    });

    return res.json({
      status: 200,
      message: `Synchronization started for session ${sessionId}`
    });
  });

  app.post('/sync/date', async (req, res) => {
    const sessionId = getSessionId(req);
    const { date } = req.body;

    if (!date) {
      return res.status(400).json({ status: 400, message: 'Date is required' });
    }

    const client = manager.getClient(sessionId, null, false);
    if (!client) {
      return res.status(400).json({ status: 400, message: `Session ${sessionId} not active` });
    }

    try {
      const result = await client.syncService.syncDateRange(date);
      return res.json({
        status: 200,
        message: `Sync completed for date ${date} on session ${sessionId}`,
        data: result
      });
    } catch (err) {
      return res.status(500).json({
        status: 500,
        message: err.message
      });
    }
  });

  return app;
}
