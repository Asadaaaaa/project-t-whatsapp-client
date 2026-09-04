import { LoggerHelper as sendLogs } from '#helpers';

export class SyncService {
  constructor(clientManager) {
    this.clientManager = clientManager;
    this.sendLogs = sendLogs;
    this.isSyncing = false;
  }

  async syncDateRange(targetDateStr) {
    if (!this.clientManager.client || this.clientManager.status !== 'connected') {
      this.sendLogs(`[SyncService:${this.clientManager.sessionId}] Cannot sync date: client not connected (status: ${this.clientManager.status})`);
      return { success: false, message: 'WhatsApp client is not connected' };
    }

    if (this.isSyncing) {
      this.sendLogs(`[SyncService:${this.clientManager.sessionId}] Sync already running for date ${targetDateStr}, skipping duplicate request`);
      return { success: true, message: 'Sync already in progress' };
    }

    this.isSyncing = true;
    const startSeconds = Math.floor(new Date(`${targetDateStr}T00:00:00+07:00`).getTime() / 1000);
    const endSeconds = Math.floor(new Date(`${targetDateStr}T23:59:59.999+07:00`).getTime() / 1000);

    try {
      if (!this.clientManager.client.pupPage || this.clientManager.client.pupPage.isClosed()) {
        return { success: false, message: 'Puppeteer page not available' };
      }

      await this.clientManager.injectFixes();
      const pupPage = this.clientManager.client.pupPage;

      this.sendLogs(`[SyncService:${this.clientManager.sessionId}] Deep scanning date ${targetDateStr} (full history & media parsing)...`);

      const executeScan = async (page) => {
        return page.evaluate(async (startSec, endSec) => {
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

        const formatMessageBody = (m) => {
          const rawBody = m.body || m.caption || '';
          const mType = (m.type || 'chat').toLowerCase();

          if (mType === 'image') {
            return rawBody ? `[Foto/Gambar: "${rawBody}"]` : `[Foto/Gambar dikirim]`;
          }
          if (mType === 'ptt') {
            const dur = m.duration ? ` (${m.duration} detik)` : '';
            return `[Voice Note / Pesan Suara${dur}]`;
          }
          if (mType === 'audio') {
            return `[Audio / Rekaman Suara]`;
          }
          if (mType === 'video') {
            return rawBody ? `[Video: "${rawBody}"]` : `[Video dikirim]`;
          }
          if (mType === 'document') {
            const fname = m.filename ? `: ${m.filename}` : '';
            return `[Dokumen/Berkas${fname}]`;
          }
          if (mType === 'sticker') {
            return `[Stiker]`;
          }
          if (mType === 'location') {
            return `[Lokasi dibagikan: ${m.loc || ''}]`;
          }
          if (mType === 'vcard' || mType === 'contact') {
            return `[Kontak WhatsApp dibagikan]`;
          }
          return rawBody;
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

            // Safe pagination to load all messages back to the target date without freezing browser
            try {
              let attempts = 0;
              while (attempts < 15) {
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
                // Small yield
                await new Promise((r) => setTimeout(r, 20));
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
                  body: formatMessageBody(m),
                  type: m.type || 'chat',
                  timestamp: ts * 1000,
                  fromMe: !!(m.id?.fromMe || m.fromMe)
                });
              }
            }

                let chatName = chat.name || chat.formattedTitle || chat.contact?.name;
                const isCommunity = !!(chat.isParentGroup || chat.groupMetadata?.isParentGroup || chat.isAnnouncementGroup);
                const isGroup = !!(chat.isGroup || isCommunity);
                if (!chatName) {
                  chatName = isCommunity ? 'Community Group' : (isGroup ? 'Group Chat' : 'Direct Chat');
                }

                results[rawChatId] = {
                  id: String(rawChatId),
                  whatsapp_chat_id: String(rawChatId),
                  name: chatName,
                  isGroup: isGroup,
                  phoneNumber: isGroup ? null : (chat.id?.user || null),
                  messages: matching
                };
          }

          // Also check global MsgCollection for any stray messages
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
                  let chatName = chatModel?.name || chatModel?.formattedTitle || chatModel?.contact?.name;
                  const isCommunity = !!(chatModel?.isParentGroup || chatModel?.groupMetadata?.isParentGroup || chatModel?.isAnnouncementGroup);
                  const isGroup = !!(chatModel?.isGroup || isCommunity);
                  if (!chatName) {
                    chatName = isCommunity ? 'Community Group' : (isGroup ? 'Group Chat' : 'Direct Chat');
                  }

                  results[rawChatId] = {
                    id: String(rawChatId),
                    whatsapp_chat_id: String(rawChatId),
                    name: chatName,
                    isGroup: isGroup,
                    phoneNumber: isGroup ? null : (chatModel?.id?.user || null),
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
                    body: formatMessageBody(m),
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
    };

      let scanResult;
      try {
        scanResult = await executeScan(pupPage);
      } catch (evalErr) {
        if (evalErr?.message && evalErr.message.includes('detached Frame')) {
          this.sendLogs(`[SyncService:${this.clientManager.sessionId}] ⚠️ Detached frame in sync_date. Triggering self-healing...`);
          await this.clientManager.handleDetachedFrame('sync_date');
          const newPupPage = this.clientManager.client.pupPage;
          scanResult = await executeScan(newPupPage);
        } else {
          throw evalErr;
        }
      }

      this.sendLogs(`[SyncService:${this.clientManager.sessionId}] Scan result: found ${Object.keys(scanResult?.data || {}).length} chats (total msgs checked: ${scanResult?.totalChecked || 0}). Error: ${scanResult?.error}`);

      const chatList = Object.values(scanResult?.data || {});
      let totalSyncedMessages = 0;

      if (chatList.length > 0) {
        for (const c of chatList) {
          totalSyncedMessages += c.messages.length;
        }

        const socketClient = this.clientManager.manager?.app?.socketClient;
        if (socketClient) {
          await socketClient.emitSyncBatch({
            sessionId: this.clientManager.sessionId,
            chats: chatList
          });
        }

        this.sendLogs(`[SyncService:${this.clientManager.sessionId}] Successfully dispatched ${totalSyncedMessages} messages from ${chatList.length} chats via Socket.IO.`);
      }

      return { success: true, count: totalSyncedMessages, chatsCount: chatList.length };
    } catch (err) {
      this.sendLogs(`[SyncService:${this.clientManager.sessionId}] Date sync error for ${targetDateStr}: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      this.isSyncing = false;
    }
  }
}

export default SyncService;
