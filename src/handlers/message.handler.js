import { LoggerHelper as sendLogs } from '#helpers';
import ReimbursementTestHandler from './reimbursement.test.handler.js';

export class MessageHandler {
  constructor(singleClient) {
    this.singleClient = singleClient;
    this.sendLogs = sendLogs;
    this.reimbursementTester = new ReimbursementTestHandler(singleClient);
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
        // Fallback
      }

      // Strict filter: Ignore archived and locked chats
      const isArchived = chat?.archive || chat?.isArchived || chat?.archived;
      const isLocked = chat?.isLocked || chat?.locked || chat?.isChatLocked || chat?.isLockChat || chat?.isLockedChat || chat?.chatLock?.isLocked || chat?.lock;
      if (isArchived || isLocked) {
        return;
      }

      const rawChatId = chat?.id?._serialized || chat?.id?.user || msgFrom;
      if (!rawChatId || rawChatId.endsWith('@newsletter') || rawChatId.endsWith('@broadcast') || rawChatId === 'status@broadcast') {
        return;
      }

      // Filter: Ignore excluded contacts/groups from Contact Exceptional config
      const senderPhone = chat?.id?.user || msgAuthor?.split?.('@')?.[0] || msgFrom?.split?.('@')?.[0];
      if (this.singleClient.isContactExcluded(rawChatId, msgAuthor || msgFrom, senderPhone)) {
        this.sendLogs(`[MessageHandler] ⛔ Pesan diabaikan: kontak/grup '${rawChatId}' masuk daftar Contact Exceptional.`);
        return;
      }

      // Hook uji coba / eksperimen reimbursement
      try {
        await this.reimbursementTester.checkAndProcess(msg, chat);
      } catch (reimbErr) {
        this.sendLogs(`[MessageHandler] Error in reimbursementTester: ${reimbErr?.message || reimbErr}`);
      }

      const isCommunity = !!(chat?.isParentGroup || chat?.groupMetadata?.isParentGroup || chat?.isAnnouncementGroup);
      const isGroup = !!(chat?.isGroup || isCommunity);
      let chatName = chat?.name || chat?.formattedTitle;
      if (!chatName) {
        chatName = isCommunity ? 'Community Group' : (isGroup ? 'Group Chat' : 'Direct Chat');
      }

      const payload = {
        sessionId: this.singleClient.sessionId,
        chat: {
          id: String(rawChatId),
          whatsapp_chat_id: String(rawChatId),
          name: chatName,
          isGroup: isGroup,
          phoneNumber: isGroup ? null : (chat?.id?.user || null)
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

      const socketClient = this.singleClient.manager?.app?.socketClient;
      if (socketClient) {
        await socketClient.emitIncomingMessage(payload);
      }
    } catch (err) {
      this.sendLogs(`[MessageHandler] Error handling message: ${err?.message || err}`);
    }
  }
}

export default MessageHandler;
