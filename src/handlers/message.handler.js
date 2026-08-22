import axios from 'axios';

export class MessageHandler {
  constructor(clientManager) {
    this.clientManager = clientManager;
  }

  async handle(msg) {
    if (!msg) return;

    try {
      const rawMsgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : null);
      if (!rawMsgId) return;

      // Skip newsletter/channel and broadcast messages
      const msgFrom = msg.from || '';
      const msgTo = msg.to || '';
      const msgAuthor = msg.author || '';
      if (
        msgFrom.endsWith('@newsletter') ||
        msgTo.endsWith('@newsletter') ||
        msgFrom.endsWith('@broadcast') ||
        msgFrom === 'status@broadcast'
      ) {
        return;
      }

      let chat = null;
      try {
        chat = await msg.getChat();
      } catch (e) {
        // Fallback to msg.from if getChat() fails
      }

      const rawChatId = chat?.id?._serialized || chat?.id?.user || msgFrom;
      if (!rawChatId || rawChatId.endsWith('@newsletter') || rawChatId.endsWith('@broadcast') || rawChatId === 'status@broadcast') {
        return;
      }

      const payload = {
        sessionId: this.clientManager.sessionId,
        chat: {
          id: String(rawChatId),
          whatsapp_chat_id: String(rawChatId),
          name: chat?.name || chat?.formattedTitle || 'Unknown',
          isGroup: !!chat?.isGroup,
          phoneNumber: chat?.isGroup ? null : (chat?.id?.user || null)
        },
        message: {
          id: String(rawMsgId),
          whatsapp_message_id: String(rawMsgId),
          sender: msgAuthor || msgFrom || null,
          receiver: msgTo || null,
          body: msg.body || '',
          type: msg.type || 'chat',
          timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
          fromMe: !!msg.fromMe
        }
      };

      await axios.post(`${this.clientManager.mainApiUrl}/api/whatsapp/internal/incoming-message`, payload, {
        timeout: 10000
      });
    } catch (err) {
      console.error('[MessageHandler] Failed to forward incoming message to Main API:', err?.message || err);
    }
  }
}
