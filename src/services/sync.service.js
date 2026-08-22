import axios from 'axios';

export class SyncService {
  constructor(clientManager) {
    this.clientManager = clientManager;
    this.isSyncing = false;
  }

  async syncDateRange(targetDateStr) {
    if (!this.clientManager.client || this.clientManager.status !== 'connected') {
      console.log(`[SyncService:${this.clientManager.sessionId}] Cannot sync date: client not connected (status: ${this.clientManager.status})`);
      return { success: false, message: 'WhatsApp client is not connected' };
    }

    const startSeconds = Math.floor(new Date(`${targetDateStr}T00:00:00+07:00`).getTime() / 1000);
    const endSeconds = Math.floor(new Date(`${targetDateStr}T23:59:59.999+07:00`).getTime() / 1000);

    try {
      await this.clientManager.injectFixes();
      const pupPage = this.clientManager.client.pupPage;

      if (!pupPage) {
        return { success: false, message: 'Puppeteer page not available' };
      }

      console.log(`[SyncService:${this.clientManager.sessionId}] Scanning date ${targetDateStr} (ignoring archived & locked chats)...`);

      const scanResult = await pupPage.evaluate(async (startSec, endSec) => {
        const results = {};
        let totalChecked = 0;

        const getChatIdString = (idObj) => {
          if (!idObj) return '';
          if (typeof idObj === 'string') return idObj;
          if (idObj._serialized) return idObj._serialized;
          if (idObj.user && idObj.server) return `${idObj.user}@${idObj.server}`;
          return String(idObj);
        };

        const isChatIgnored = (chat) => {
          if (!chat) return false;
          // Ignore archived chats
          if (chat.archive || chat.isArchived || chat.archived) return true;
          // Ignore locked chats
          if (
            chat.isLocked ||
            chat.locked ||
            chat.isChatLocked ||
            chat.isLockChat ||
            chat.isLockedChat ||
            chat.chatLock?.isLocked ||
            chat.lock
          ) {
            return true;
          }
          return false;
        };

        try {
          const WAWebCollections = window.require?.('WAWebCollections');
          const MsgCollection = WAWebCollections?.Msg;
          const ChatCollection = WAWebCollections?.Chat;

          if (!ChatCollection) {
            return { error: 'ChatCollection not found', data: {}, totalChecked: 0 };
          }

          const chats = ChatCollection.getModelsArray ? ChatCollection.getModelsArray() : [];

          for (const chat of chats) {
            const rawChatId = getChatIdString(chat.id);
            if (
              !rawChatId ||
              rawChatId === 'status@broadcast' ||
              rawChatId.endsWith('@broadcast') ||
              rawChatId.endsWith('@newsletter')
            ) {
              continue;
            }

            // Exclude archived and locked chats
            if (isChatIgnored(chat)) {
              continue;
            }

            const chatLastActivity = chat.t || chat.timestamp || 0;
            if (chatLastActivity > 0 && chatLastActivity < startSec) {
              continue;
            }

            // Load earlier messages if needed
            try {
              let attempts = 0;
              while (attempts < 6) {
                const currentMsgs = chat.msgs ? (chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : (chat.msgs._models || [])) : [];
                const oldestMsgTs = currentMsgs.length > 0 ? (currentMsgs[0].t || currentMsgs[0].timestamp || 0) : chatLastActivity;
                if (oldestMsgTs > 0 && oldestMsgTs <= startSec) {
                  break;
                }

                const loader = window.require?.('WAWebChatLoadMessages');
                if (loader?.loadEarlierMsgs) {
                  const loaded = await loader.loadEarlierMsgs({ chat });
                  if (!loaded || !loaded.length) break;
                } else if (chat.loadEarlierMsgs) {
                  const loaded = await chat.loadEarlierMsgs();
                  if (!loaded) break;
                } else {
                  break;
                }
                attempts++;
              }
            } catch (loadErr) {}

            const msgsArray = chat.msgs ? (chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : (chat.msgs._models || [])) : [];
            totalChecked += msgsArray.length;

            const matching = [];
            for (const m of msgsArray) {
              if (m.isNotification) continue;
              const ts = m.t || m.timestamp;
              if (ts && ts >= startSec && ts <= endSec) {
                const strId = getChatIdString(m.id);
                matching.push({
                  id: strId || String(m.id?.id || ''),
                  whatsapp_message_id: strId || String(m.id?.id || ''),
                  sender: m.author || m.from ? getChatIdString(m.author || m.from) : null,
                  receiver: m.to ? getChatIdString(m.to) : null,
                  body: m.body || m.caption || '',
                  type: m.type || 'chat',
                  timestamp: ts * 1000,
                  fromMe: !!(m.id?.fromMe || m.fromMe)
                });
              }
            }

            if (matching.length > 0) {
              results[rawChatId] = {
                id: String(rawChatId),
                whatsapp_chat_id: String(rawChatId),
                name: chat.name || chat.formattedTitle || chat.contact?.name || 'Direct Chat',
                isGroup: !!chat.isGroup,
                phoneNumber: chat.isGroup ? null : (chat.id?.user || null),
                messages: matching
              };
            }
          }

          // Also check global MsgCollection
          if (MsgCollection) {
            const globalMsgs = MsgCollection.getModelsArray ? MsgCollection.getModelsArray() : [];
            totalChecked += globalMsgs.length;

            for (const m of globalMsgs) {
              if (m.isNotification) continue;
              const ts = m.t || m.timestamp;
              if (ts && ts >= startSec && ts <= endSec) {
                const rawChatId = getChatIdString(m.id?.remote || m.to || m.from);
                if (!rawChatId || rawChatId === 'status@broadcast' || rawChatId.endsWith('@broadcast') || rawChatId.endsWith('@newsletter')) continue;

                const chatModel = ChatCollection.get(rawChatId);
                // Exclude archived and locked chats in global scan
                if (isChatIgnored(chatModel)) {
                  continue;
                }

                if (!results[rawChatId]) {
                  results[rawChatId] = {
                    id: String(rawChatId),
                    whatsapp_chat_id: String(rawChatId),
                    name: chatModel?.name || chatModel?.formattedTitle || 'Direct Chat',
                    isGroup: !!chatModel?.isGroup,
                    phoneNumber: chatModel?.isGroup ? null : (chatModel?.id?.user || null),
                    messages: []
                  };
                }

                const strId = getChatIdString(m.id);
                const exists = results[rawChatId].messages.some((x) => x.whatsapp_message_id === strId);
                if (!exists) {
                  results[rawChatId].messages.push({
                    id: strId || String(m.id?.id || ''),
                    whatsapp_message_id: strId || String(m.id?.id || ''),
                    sender: m.author || m.from ? getChatIdString(m.author || m.from) : null,
                    receiver: m.to ? getChatIdString(m.to) : null,
                    body: m.body || m.caption || '',
                    type: m.type || 'chat',
                    timestamp: ts * 1000,
                    fromMe: !!(m.id?.fromMe || m.fromMe)
                  });
                }
              }
            }
          }

          return { error: null, data: results, totalChecked };
        } catch (err) {
          return { error: err.message, data: {}, totalChecked };
        }
      }, startSeconds, endSeconds);

      console.log(`[SyncService:${this.clientManager.sessionId}] Scan result: found ${Object.keys(scanResult.data || {}).length} chats (total msgs checked: ${scanResult.totalChecked}). Error: ${scanResult.error}`);

      const chatList = Object.values(scanResult.data || {});
      let totalSyncedMessages = 0;

      if (chatList.length > 0) {
        for (const c of chatList) {
          totalSyncedMessages += c.messages.length;
        }

        await axios.post(
          `${this.clientManager.mainApiUrl}/api/whatsapp/internal/sync-batch`,
          {
            sessionId: this.clientManager.sessionId,
            chats: chatList
          },
          { timeout: 30000 }
        );

        console.log(`[SyncService:${this.clientManager.sessionId}] Successfully posted ${totalSyncedMessages} messages from ${chatList.length} chats to Main API.`);
      }

      return { success: true, count: totalSyncedMessages, chatsCount: chatList.length };
    } catch (err) {
      console.error(`[SyncService:${this.clientManager.sessionId}] Date sync error for ${targetDateStr}:`, err.message);
      return { success: false, error: err.message };
    }
  }
}
