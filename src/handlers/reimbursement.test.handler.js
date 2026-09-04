import crypto from 'node:crypto';
import { LoggerHelper as sendLogs } from '#helpers';

function decryptWhatsAppMediaBuffer(encBuffer, mediaKeyBase64, mediaType = 'image') {
  try {
    const mediaKey = Buffer.from(mediaKeyBase64, 'base64');
    let info = 'WhatsApp Image Keys';
    if (mediaType === 'video') info = 'WhatsApp Video Keys';
    else if (mediaType === 'audio') info = 'WhatsApp Audio Keys';
    else if (mediaType === 'document') info = 'WhatsApp Document Keys';

    const mediaKeyExpanded = Buffer.from(crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(info), 112));
    const iv = mediaKeyExpanded.subarray(0, 16);
    const cipherKey = mediaKeyExpanded.subarray(16, 48);
    const fileData = encBuffer.subarray(0, encBuffer.length - 10);
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    return Buffer.concat([decipher.update(fileData), decipher.final()]);
  } catch (err) {
    return null;
  }
}

export class ReimbursementTestHandler {
  constructor(singleClient) {
    this.singleClient = singleClient;
    this.sendLogs = sendLogs;

    // Set untuk melacak pesan yang sudah pernah diproses agar scan 10s tidak memproses ulang
    this.processedMsgIds = new Set();
  }

  getExtFromMime(mimetype) {
    if (!mimetype) return '.jpg';
    if (mimetype.includes('jpeg')) return '.jpg';
    if (mimetype.includes('png')) return '.png';
    if (mimetype.includes('webp')) return '.webp';
    return '.jpg';
  }

  async checkAndProcess(msg, chat, options = {}) {
    if (!msg) return;

    const body = msg.body || msg.caption || '';
    const hasTag = /#?reimburse/i.test(body);

    // Hanya proses jika pesan memiliki tag #reimburse atau kata reimburse
    if (!hasTag) {
      return;
    }

    const msgId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : (msg.id ? JSON.stringify(msg.id) : 'unknown'));

    if (this.processedMsgIds.has(msgId) && !options.force) {
      return null;
    }

    const chatTitle = chat?.name || chat?.formattedTitle || 'Direct Chat';
    const chatId = chat?.id?._serialized || msg.from;
    const author = msg.author || msg.from;
    const senderPhone = chat?.id?.user || author?.split?.('@')?.[0];

    // Filter: Ignore excluded contacts/groups from Contact Exceptional config
    if (this.singleClient.isContactExcluded(chatId, author, senderPhone)) {
      this.sendLogs(`[ReimbursementTest] ⛔ Dilewati: Chat/Pengirim '${chatId}' masuk daftar Contact Exceptional.`);
      return null;
    }

    this.sendLogs(`\n================== [TEST REIMBURSE DETECTED] ==================`);
    this.sendLogs(`[ReimbursementTest] 🔍 Terdeteksi pesan dengan tag #reimburse!`);
    this.sendLogs(`[ReimbursementTest] ID Pesan: ${msgId}`);
    this.sendLogs(`[ReimbursementTest] Chat: ${chatTitle} (${chatId})`);
    this.sendLogs(`[ReimbursementTest] Pengirim: ${msg.author || msg.from || (msg.fromMe ? 'Saya' : 'Unknown')}`);
    this.sendLogs(`[ReimbursementTest] Tipe pesan: ${msg.type}, hasMedia: ${msg.hasMedia}`);
    this.sendLogs(`[ReimbursementTest] Caption: "${body}"`);

    // 1. Verifikasi apakah pesan utama berupa gambar
    const isMainImage = msg.type === 'image' || (msg.hasMedia && msg.type === 'image');
    if (!isMainImage) {
      const reason = `Pesan BUKAN berupa gambar (tipe pesan: "${msg.type}"). Syarat: pesan harus berupa gambar.`;
      this.sendLogs(`[ReimbursementTest] ⚠️ Evaluasi Gagal: ${reason}`);
      this.sendLogs(`===================================================================\n`);
      return {
        success: false,
        msgId,
        caption: body,
        chat: chatTitle,
        reason
      };
    }

    // 2. Verifikasi apakah pesan me-reply pesan lain (periksa seluruh indikator quoted)
    const hasQuoted = Boolean(
      msg.hasQuotedMsg ||
      msg.quotedStanzaID ||
      msg._data?.quotedStanzaID ||
      msg._data?.quotedMsg ||
      msg.quotedMsgObj ||
      msg.quotedMsg ||
      msg._quotedMsgObj ||
      msg.__x_quotedMsg ||
      msg.__x_quotedStanzaID
    );

    if (!hasQuoted) {
      const reason = `Pesan gambar TIDAK me-reply pesan apapun. Syarat: pesan gambar harus me-reply pesan gambar lainnya.`;
      this.sendLogs(`[ReimbursementTest] ⚠️ Evaluasi Gagal: ${reason}`);
      this.sendLogs(`===================================================================\n`);
      return {
        success: false,
        msgId,
        caption: body,
        chat: chatTitle,
        isImage: true,
        hasQuotedMsg: false,
        reason
      };
    }

    let quotedMsg = null;
    try {
      quotedMsg = await this.getQuotedMessageSafely(msg);
    } catch (err) {
      const reason = `Gagal mengambil pesan yang di-reply: ${err?.message || err}`;
      this.sendLogs(`[ReimbursementTest] ❌ ${reason}`);
      this.sendLogs(`===================================================================\n`);
      return {
        success: false,
        msgId,
        caption: body,
        chat: chatTitle,
        reason
      };
    }

    if (!quotedMsg) {
      const reason = `Pesan yang di-reply tidak ditemukan (null).`;
      this.sendLogs(`[ReimbursementTest] ⚠️ ${reason}`);
      this.sendLogs(`===================================================================\n`);
      return {
        success: false,
        msgId,
        caption: body,
        chat: chatTitle,
        reason
      };
    }

    const quotedId = quotedMsg.id?._serialized || quotedMsg.id?.id || (typeof quotedMsg.id === 'string' ? quotedMsg.id : (quotedMsg._data?.id || 'QUOTED'));
    const quotedSender = quotedMsg.author || quotedMsg.from || (quotedMsg.fromMe ? 'Saya' : 'Unknown');
    const quotedBody = quotedMsg.body || quotedMsg.caption || '';

    this.sendLogs(`[ReimbursementTest] 📌 Data Pesan yang di-reply:`);
    this.sendLogs(`[ReimbursementTest] - ID: ${quotedId}`);
    this.sendLogs(`[ReimbursementTest] - Pengirim: ${quotedSender}`);
    this.sendLogs(`[ReimbursementTest] - Tipe: ${quotedMsg.type}, hasMedia: ${quotedMsg.hasMedia}`);
    this.sendLogs(`[ReimbursementTest] - Isi/Caption: "${quotedBody}"`);

    // 3. Verifikasi apakah pesan yang di-reply juga berupa gambar
    const isQuotedImage = quotedMsg.type === 'image' || (quotedMsg.hasMedia && quotedMsg.type === 'image');
    if (!isQuotedImage) {
      const reason = `Pesan yang di-reply BUKAN gambar (tipe: "${quotedMsg.type}"). Syarat: pesan yang di-reply harus pesan gambar.`;
      this.sendLogs(`[ReimbursementTest] ⚠️ Evaluasi Gagal: ${reason}`);
      this.sendLogs(`===================================================================\n`);
      return {
        success: false,
        msgId,
        caption: body,
        chat: chatTitle,
        isImage: true,
        hasQuotedMsg: true,
        quotedType: quotedMsg.type,
        reason
      };
    }

    this.sendLogs(`[ReimbursementTest] ✅ SEMUA KRITERIA TERPENUHI!`);
    this.sendLogs(`[ReimbursementTest] 📥 Sedang mendownload media untuk kedua gambar...`);

    // Pastikan kunci dekripsi media dari payload pesan diteruskan ke objek quotedMsg
    if (quotedMsg && msg._data?.quotedMsg) {
      const qm = msg._data.quotedMsg;
      quotedMsg.directPath = quotedMsg.directPath || qm.directPath;
      quotedMsg.encFilehash = quotedMsg.encFilehash || qm.encFilehash;
      quotedMsg.filehash = quotedMsg.filehash || qm.filehash;
      quotedMsg.mediaKey = quotedMsg.mediaKey || qm.mediaKey;
      quotedMsg.mediaKeyTimestamp = quotedMsg.mediaKeyTimestamp || qm.mediaKeyTimestamp;
      quotedMsg.mimetype = quotedMsg.mimetype || qm.mimetype;
      if (quotedMsg._data) {
        quotedMsg._data.directPath = quotedMsg._data.directPath || qm.directPath;
        quotedMsg._data.encFilehash = quotedMsg._data.encFilehash || qm.encFilehash;
        quotedMsg._data.filehash = quotedMsg._data.filehash || qm.filehash;
        quotedMsg._data.mediaKey = quotedMsg._data.mediaKey || qm.mediaKey;
        quotedMsg._data.mediaKeyTimestamp = quotedMsg._data.mediaKeyTimestamp || qm.mediaKeyTimestamp;
        quotedMsg._data.mimetype = quotedMsg._data.mimetype || qm.mimetype;
        quotedMsg._data.body = quotedMsg._data.body || qm.body;
      }
    }

    try {
      const mainMedia = await this.downloadMediaSafely(msg);
      const quotedMedia = await this.downloadMediaSafely(quotedMsg);

      this.sendLogs(`[ReimbursementTest] mainMedia: ${Boolean(mainMedia?.data)}, quotedMedia: ${Boolean(quotedMedia?.data)} untuk msgId: ${msgId}`);
      if (!mainMedia?.data || !quotedMedia?.data) {
        const reason = `Media data missing (main: ${Boolean(mainMedia?.data)}, quoted: ${Boolean(quotedMedia?.data)})`;
        this.sendLogs(`[ReimbursementTest] ❌ ${reason}`);
        return { success: false, msgId, reason };
      }

      this.sendLogs(`[ReimbursementTest] 🎉 Download media kedua gambar berhasil! Mengirimkan ke Controller...`);

      // Dapatkan identitas pemohon / yang me-request reimbursement (dari pesan nota/quotedMsg)
      const { senderPhone, senderName } = await this.resolveRequesterInfo(quotedMsg, chat, msg);
      this.sendLogs(`[ReimbursementTest] 👤 Pemohon (Yang Request) teridentifikasi: "${senderName}" (${senderPhone})`);

      // Kirim data lengkap ke Controller API via Socket.IO untuk disimpan & dianalisis Gemini AI
      try {
        const socketClient = this.singleClient.manager?.app?.socketClient;
        if (socketClient) {
          const res = await socketClient.emitReimbursementDetected({
            whatsapp_message_id: msgId,
            quoted_message_id: quotedId,
            chat_id: chatId,
            chat_name: chatTitle,
            sender_phone: senderPhone,
            sender_name: senderName,
            reimburse_image_base64: mainMedia.data,
            reimburse_mime: mainMedia?.mimetype || 'image/jpeg',
            receipt_image_base64: quotedMedia.data,
            receipt_mime: quotedMedia?.mimetype || 'image/jpeg',
            timestamp: msg.timestamp ? msg.timestamp * 1000 : Date.now()
          });
          this.sendLogs(`[ReimbursementTest] 📡 Hasil kirim ke Controller: ${JSON.stringify(res)}`);
        }
      } catch (sockErr) {
        this.sendLogs(`[ReimbursementTest] Error emit socket ke controller: ${sockErr.message}`);
      }

      this.processedMsgIds.add(msgId);
      this.sendLogs(`===================================================================\n`);

      return {
        success: true,
        msgId,
        quotedId,
        chatId
      };
    } catch (err) {
      this.sendLogs(`[ReimbursementTest] ❌ Gagal mendownload / memproses media: ${err.message}`);
      this.sendLogs(`===================================================================\n`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Mengambil pesan yang di-reply dengan fallback multi-level jika getQuotedMessage() bawaan error
   */
  async getQuotedMessageSafely(msg) {
    if (!msg) return null;

    // 1. Coba getQuotedMessage bawaan whatsapp-web.js
    try {
      const quoted = await msg.getQuotedMessage();
      if (quoted) return quoted;
    } catch (err) {
      this.sendLogs(`[ReimbursementTest] getQuotedMessage bawaan gagal (${err?.message || err}), mencoba metode alternatif...`);
    }

    // 2. Ambil dari browser Puppeteer store
    try {
      const pupPage = this.singleClient.client?.pupPage;
      const parentId = msg.id?._serialized || msg.id?.$1 || (typeof msg.id === 'string' ? msg.id : (msg.id?.id || null));
      const targetStanza = msg.quotedStanzaID || msg._data?.quotedStanzaID || msg._data?.quotedMsg?.id?.id || msg.__x_quotedStanzaID;
      if (pupPage && !pupPage.isClosed()) {
        const quotedData = await pupPage.evaluate(async (pId, qStanza) => {
          const WAWebCollections = window.require?.('WAWebCollections');
          const MsgCollection = WAWebCollections?.Msg;
          if (!MsgCollection) return null;

          let parent = null;
          if (pId) parent = MsgCollection.get(pId);
          if (!parent && MsgCollection.getModelsArray) {
            const all = MsgCollection.getModelsArray();
            parent = all.find(m => {
              const mid = m.id?._serialized || m.id?.$1 || m.id?.id || (typeof m.id === 'string' ? m.id : '');
              return mid === pId || (pId && (mid.includes(pId) || pId.includes(mid)));
            });
          }

          let q = null;
          if (parent) {
            try {
              if (typeof parent.quotedMsgObj === 'function') q = parent.quotedMsgObj();
              else if (parent.quotedMsgObj) q = parent.quotedMsgObj;
            } catch (e) {}
            if (!q && parent._quotedMsgObj) q = parent._quotedMsgObj;
            if (!q && parent.__x_quotedMsg) q = parent.__x_quotedMsg;
            if (!q && parent.quotedMsg) q = parent.quotedMsg;
            if (!q && parent._data?.quotedMsg) q = parent._data.quotedMsg;
          }

          const stanzaId = qStanza || parent?.quotedStanzaID || parent?._data?.quotedStanzaID || parent?.__x_quotedStanzaID;
          if (!q && stanzaId && MsgCollection.getModelsArray) {
            const all = MsgCollection.getModelsArray();
            q = all.find((m) => {
              const mid = m.id?._serialized || m.id?.$1 || m.id?.id || (typeof m.id === 'string' ? m.id : '');
              return mid === stanzaId || mid.includes(stanzaId) || stanzaId.includes(mid);
            });
          }

          if (q && window.WWebJS?.getMessageModel) {
            return window.WWebJS.getMessageModel(q);
          }

          if (q) return q;
          return null;
        }, parentId, targetStanza);

        if (quotedData) {
          const pkg = await import('whatsapp-web.js');
          const MessageClass = pkg.default?.Message || pkg.Message;
          return new MessageClass(this.singleClient.client, quotedData);
        }
      }
    } catch (e) {
      this.sendLogs(`[ReimbursementTest] Gagal fallback quoted via Puppeteer: ${e.message}`);
    }

    // 3. Fallback langsung dari msg._data.quotedMsg
    if (msg._data && msg._data.quotedMsg) {
      this.sendLogs(`[ReimbursementTest] Menggunakan fallback data quotedMsg lokal.`);
      const pkg = await import('whatsapp-web.js');
      const MessageClass = pkg.default?.Message || pkg.Message;
      const raw = { ...msg._data.quotedMsg };
      if (!raw.id) {
        const fallbackId = msg._data.quotedStanzaID || msg.quotedStanzaID || 'QUOTED_' + Date.now();
        raw.id = {
          fromMe: false,
          remote: msg.from,
          id: fallbackId,
          _serialized: `false_${msg.from}_${fallbackId}`
        };
      }
      return new MessageClass(this.singleClient.client, raw);
    }

    return null;
  }

  /**
   * Mengunduh media pesan secara aman dengan fallback
   */
  async downloadMediaSafely(msgToDownload) {
    if (!msgToDownload) return null;

    const idStr = msgToDownload.id?._serialized || (typeof msgToDownload.id === 'string' ? msgToDownload.id : (msgToDownload.id?.id || null));

    try {
      if (typeof msgToDownload.downloadMedia === 'function') {
        const m = await msgToDownload.downloadMedia();
        if (m && m.data) {
          this.sendLogs(`[ReimbursementTest] downloadMedia bawaan berhasil untuk: ${idStr}`);
          return m;
        }
      }
    } catch (e) {
      this.sendLogs(`[ReimbursementTest] downloadMedia bawaan gagal (${idStr}): ${e.message}`);
    }

    // 2. Direct fetch & decrypt via Node.js (sangat cepat & tidak bergantung pada browser)
    try {
      const directPath = msgToDownload.directPath || msgToDownload.mediaData?.directPath || msgToDownload._data?.directPath;
      const mediaKey = msgToDownload.mediaKey || msgToDownload.mediaData?.mediaKey || msgToDownload._data?.mediaKey;
      if (directPath && mediaKey) {
        const url = directPath.startsWith('http') ? directPath : ('https://mmg.whatsapp.net' + directPath);
        const resp = await fetch(url);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          const decrypted = decryptWhatsAppMediaBuffer(Buffer.from(ab), mediaKey, msgToDownload.type || 'image');
          if (decrypted && decrypted.length > 0) {
            this.sendLogs(`[ReimbursementTest] Direct Node.js decrypt berhasil untuk: ${idStr} (${decrypted.length} bytes)`);
            return {
              data: decrypted.toString('base64'),
              mimetype: msgToDownload.mimetype || msgToDownload._data?.mimetype || 'image/jpeg',
              filesize: decrypted.length
            };
          }
        }
      }
    } catch (nodeDecryptErr) {
      this.sendLogs(`[ReimbursementTest] Info direct Node.js decrypt (${idStr}): ${nodeDecryptErr.message}`);
    }

    // 3. Fallback download via Puppeteer WAWebDownloadManager
    try {
      const pupPage = this.singleClient.client?.pupPage;
      if (pupPage && !pupPage.isClosed()) {
        const mediaObj = {
          directPath: msgToDownload.directPath || msgToDownload.mediaData?.directPath || msgToDownload._data?.directPath,
          encFilehash: msgToDownload.encFilehash || msgToDownload.mediaData?.encFilehash || msgToDownload._data?.encFilehash,
          filehash: msgToDownload.filehash || msgToDownload.mediaData?.filehash || msgToDownload._data?.filehash,
          mediaKey: msgToDownload.mediaKey || msgToDownload.mediaData?.mediaKey || msgToDownload._data?.mediaKey,
          mediaKeyTimestamp: msgToDownload.mediaKeyTimestamp || msgToDownload.mediaData?.mediaKeyTimestamp || msgToDownload._data?.mediaKeyTimestamp,
          type: msgToDownload.type || 'image',
          mimetype: msgToDownload.mimetype || msgToDownload.mediaData?.mimetype || msgToDownload._data?.mimetype || 'image/jpeg',
          thumbnail: (typeof msgToDownload._data?.body === 'string' && msgToDownload._data.body.length > 20) ? msgToDownload._data.body : null
        };
        const stanzaTarget = msgToDownload.id?.id || msgToDownload._data?.quotedStanzaID || (idStr ? idStr.split('_').pop() : null);

        const res = await pupPage.evaluate(async (targetId, targetStanza, directKeys) => {
          try {
            const WAWebCollections = window.require?.('WAWebCollections');
            const MsgCollection = WAWebCollections?.Msg;

            let m = null;
            if (MsgCollection) {
              if (targetId) m = MsgCollection.get(targetId);
              if (!m && targetStanza) m = MsgCollection.get(targetStanza);
              if (!m && MsgCollection.getModelsArray) {
                const all = MsgCollection.getModelsArray();
                m = all.find((x) => 
                  (targetId && (x.id?._serialized === targetId || x.id?.id === targetId || targetId.includes(x.id?.id))) ||
                  (targetStanza && (x.id?.id === targetStanza || x.id?._serialized?.includes(targetStanza)))
                );
              }
              if (!m && MsgCollection.getMessagesById && targetId) {
                const list = await MsgCollection.getMessagesById([targetId]);
                m = list?.messages?.[0];
              }
            }

            if (m && m.mediaData?.data) {
              return {
                data: m.mediaData.data,
                mimetype: m.mimetype || m.mediaData?.mimetype || 'image/jpeg'
              };
            }

            if (m && m.mediaData?.mediaStage !== 'RESOLVED' && typeof m.downloadMedia === 'function') {
              try {
                await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                if (m.mediaData?.data) {
                  return {
                    data: m.mediaData.data,
                    mimetype: m.mimetype || m.mediaData?.mimetype || 'image/jpeg'
                  };
                }
              } catch (dlErr) {}
            }

            const downloadMgr = window.require?.('WAWebDownloadManager')?.downloadManager;
            if (downloadMgr) {
              const mockQpl = {
                addAnnotations: () => mockQpl,
                addPoint: () => mockQpl
              };

              const directPath = directKeys?.directPath || m?.directPath || m?.mediaData?.directPath;
              const encFilehash = directKeys?.encFilehash || m?.encFilehash || m?.mediaData?.encFilehash;
              const filehash = directKeys?.filehash || m?.filehash || m?.mediaData?.filehash;
              const mediaKey = directKeys?.mediaKey || m?.mediaKey || m?.mediaData?.mediaKey;
              const mediaKeyTimestamp = directKeys?.mediaKeyTimestamp || m?.mediaKeyTimestamp || m?.mediaData?.mediaKeyTimestamp;
              const type = directKeys?.type || m?.type || 'image';

              if (!directPath || !encFilehash || !mediaKey) {
                if (directKeys?.thumbnail) {
                  return {
                    data: directKeys.thumbnail,
                    mimetype: 'image/jpeg',
                    isThumbnail: true
                  };
                }
                return {
                  error: `Missing decrypt keys (directPath: ${Boolean(directPath)}, encFilehash: ${Boolean(encFilehash)}, mediaKey: ${Boolean(mediaKey)})`
                };
              }

              try {
                const decrypted = await downloadMgr.downloadAndMaybeDecrypt({
                    directPath,
                    encFilehash,
                    filehash,
                    mediaKey,
                    mediaKeyTimestamp,
                    type,
                    signal: new AbortController().signal,
                    downloadQpl: mockQpl
                  });

                  if (decrypted) {
                    const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
                    return {
                      data,
                      mimetype: m?.mimetype || directKeys?.mimetype || 'image/jpeg',
                      filename: m?.filename || null,
                      filesize: m?.size || 0
                    };
                  }
                } catch (decErr) {
                  if (directKeys?.thumbnail) {
                    return {
                      data: directKeys.thumbnail,
                      mimetype: 'image/jpeg',
                      isThumbnail: true
                    };
                  }
                  return { error: 'downloadAndMaybeDecrypt failed: ' + decErr.message };
                }
            }

            // Fallback thumbnail jika media resolusi penuh tidak dapat diunduh
            if (directKeys?.thumbnail) {
              return {
                data: directKeys.thumbnail,
                mimetype: 'image/jpeg',
                isThumbnail: true
              };
            }

            return { error: 'Gagal mengunduh media dari semua metode' };
          } catch (err) {
            return { error: err.message };
          }
        }, idStr, stanzaTarget, mediaObj);

        if (res && res.data) {
          this.sendLogs(`[ReimbursementTest] Fallback WAWebDownloadManager berhasil untuk: ${idStr || stanzaTarget}`);
          return res;
        } else if (res?.error) {
          this.sendLogs(`[ReimbursementTest] Info fallback download (${idStr || stanzaTarget}): ${res.error}`);
        }
      }
    } catch (e) {
      this.sendLogs(`[ReimbursementTest] Error download fallback: ${e.message}`);
    }

    // 4. Fallback thumbnail langsung dari raw body
    const thumbData = msgToDownload._data?.body;
    if (typeof thumbData === 'string' && thumbData.length > 20) {
      this.sendLogs(`[ReimbursementTest] Menggunakan fallback thumbnail preview untuk: ${idStr}`);
      return {
        data: thumbData.replace(/^data:image\/[a-z]+;base64,/, ''),
        mimetype: 'image/jpeg',
        isThumbnail: true
      };
    }

    return null;
  }

  /**
   * Pindai riwayat chat lama yang sudah ada di WhatsApp tanpa perlu mengirim pesan baru
   */
  async scanHistory(options = {}) {
    const isQuiet = options.quiet === true;
    const isReadyOrAuthed = this.singleClient.status === 'connected' || this.singleClient.status === 'authenticated';
    if (!this.singleClient.client || !isReadyOrAuthed) {
      if (!isQuiet) {
        this.sendLogs(`[ReimbursementTest] ⚠️ WhatsApp belum terhubung (status: ${this.singleClient.status}), tidak dapat memindai.`);
      }
      return;
    }

    if (!isQuiet) {
      this.sendLogs(`\n================== [SCAN RIWAYAT REIMBURSEMENT] ==================`);
      this.sendLogs(`[ReimbursementTest] 🔍 Memulai pencarian pesan lama dengan tag #reimburse...`);
    }

    const foundMsgIds = new Set();
    const candidateMessages = [];

    // 1. Coba gunakan fitur search bawaan WhatsApp Web
    try {
      if (!isQuiet) this.sendLogs(`[ReimbursementTest] 🔎 Mencari melalui client.searchMessages('reimburse')...`);
      const searchResults = await this.singleClient.client.searchMessages('reimburse', { limit: 50 });
      if (searchResults && searchResults.length > 0) {
        if (!isQuiet) this.sendLogs(`[ReimbursementTest] Ditemukan ${searchResults.length} pesan via searchMessages.`);
        for (const msg of searchResults) {
          const id = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : '');
          if (id && !foundMsgIds.has(id)) {
            foundMsgIds.add(id);
            candidateMessages.push(msg);
          }
        }
      } else if (!isQuiet) {
        this.sendLogs(`[ReimbursementTest] searchMessages tidak mengembalikan pesan. Memindai memori chat aktif...`);
      }
    } catch (searchErr) {
      if (!isQuiet) this.sendLogs(`[ReimbursementTest] Info searchMessages: ${searchErr.message}. Memindai memori chat langsung...`);
    }

    // 2. Pemindaian langsung ke koleksi memori chat di browser Puppeteer
    try {
      if (this.singleClient.client.pupPage && !this.singleClient.client.pupPage.isClosed()) {
        const rawIds = await this.singleClient.client.pupPage.evaluate(async () => {
          const matchIds = [];
          const WAWebCollections = window.require?.('WAWebCollections');
          const ChatCollection = WAWebCollections?.Chat;
          const MsgCollection = WAWebCollections?.Msg;

          // Cek di MsgCollection
          if (MsgCollection && MsgCollection.getModelsArray) {
            const allMsgs = MsgCollection.getModelsArray();
            for (const m of allMsgs) {
              const body = m.body || m.caption || '';
              if (/#?reimburse/i.test(body)) {
                const id = m.id?._serialized || m.id?.$1 || (typeof m.id === 'string' ? m.id : (m.id?.id || null));
                if (id) matchIds.push(id);
              }
            }
          }

          // Cek di ChatCollection
          if (ChatCollection && ChatCollection.getModelsArray) {
            const chats = ChatCollection.getModelsArray();
            for (const chat of chats) {
              const msgs = chat.msgs ? (chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : (chat.msgs._models || [])) : [];
              for (const m of msgs) {
                const body = m.body || m.caption || '';
                if (/#?reimburse/i.test(body)) {
                  const id = m.id?._serialized || m.id?.$1 || (typeof m.id === 'string' ? m.id : (m.id?.id || null));
                  if (id) matchIds.push(id);
                }
              }
            }
          }

          return [...new Set(matchIds)];
        });

        if (rawIds && rawIds.length > 0) {
          if (!isQuiet) this.sendLogs(`[ReimbursementTest] Ditemukan ${rawIds.length} ID pesan dari memori browser.`);
          for (const rawId of rawIds) {
            if (!foundMsgIds.has(rawId)) {
              foundMsgIds.add(rawId);
              try {
                let msgObj = null;
                try {
                  msgObj = await this.singleClient.client.getMessageById(rawId);
                } catch (err) {}

                if (!msgObj && this.singleClient.client.pupPage) {
                  const mData = await this.singleClient.client.pupPage.evaluate((targetId) => {
                    const WAWebCollections = window.require?.('WAWebCollections');
                    const MsgCollection = WAWebCollections?.Msg;
                    let found = MsgCollection?.get(targetId);
                    if (!found && MsgCollection?.getModelsArray) {
                      found = MsgCollection.getModelsArray().find(x => {
                        const mid = x.id?._serialized || x.id?.$1 || x.id?.id || '';
                        return mid === targetId || mid.includes(targetId) || targetId.includes(mid);
                      });
                    }
                    if (found && window.WWebJS?.getMessageModel) {
                      return window.WWebJS.getMessageModel(found);
                    }
                    return null;
                  }, rawId);

                  if (mData) {
                    const pkg = await import('whatsapp-web.js');
                    const MessageClass = pkg.default?.Message || pkg.Message;
                    msgObj = new MessageClass(this.singleClient.client, mData);
                  }
                }

                if (msgObj) {
                  candidateMessages.push(msgObj);
                }
              } catch (e) {}
            }
          }
        }
      }
    } catch (deepScanErr) {
      if (!isQuiet) this.sendLogs(`[ReimbursementTest] Error scan memori browser: ${deepScanErr.message}`);
    }

    // 3. Pemindaian chat aktif langsung (memuat pesan yang belum ter-load di memori)
    try {
      const activeChats = await this.singleClient.client.getChats();
      const topChats = (activeChats || []).slice(0, 15);
      for (const c of topChats) {
        try {
          const msgs = await c.fetchMessages({ limit: 30 });
          for (const m of msgs) {
            const body = m.body || m.caption || '';
            if (/#?(reimburse|reimburs|remburse|rembes)/i.test(body)) {
              const id = m.id?._serialized || m.id?.id || (typeof m.id === 'string' ? m.id : '');
              if (id && !foundMsgIds.has(id)) {
                foundMsgIds.add(id);
                candidateMessages.push(m);
              }
            }
          }
        } catch (fetchErr) {}
      }
    } catch (getChatsErr) {}

    // Filter kandidat yang belum pernah diproses dan bukan dari kontak yang dikecualikan
    const unhandledCandidates = candidateMessages.filter(msg => {
      const id = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : '');
      const chatId = msg.from || msg.to || '';
      const author = msg.author || '';
      if (this.singleClient.isContactExcluded(chatId, author)) {
        return false;
      }
      return id && !this.processedMsgIds.has(id);
    });

    if (unhandledCandidates.length === 0) {
      if (!isQuiet) {
        this.sendLogs(`[ReimbursementTest] ℹ️ Tidak ada pesan #reimburse baru yang belum diproses.`);
        this.sendLogs(`===================================================================\n`);
      }
      return {
        success: true,
        candidateCount: candidateMessages.length,
        unhandledCount: 0,
        extractedCount: 0,
        items: []
      };
    }

    this.sendLogs(`\n[ReimbursementScanner] 🔔 Ditemukan ${unhandledCandidates.length} pesan #reimburse baru yang belum diproses! Memproses sekarang...`);

    const extractedItems = [];
    const evaluations = [];
    for (const msg of unhandledCandidates) {
      let chat = null;
      try {
        chat = await msg.getChat();
      } catch (e) {}

      const strId = msg.id?._serialized || msg.id?.id || (typeof msg.id === 'string' ? msg.id : '');
      this.sendLogs(`[ReimbursementScanner] Memproses kandidat: id=${strId}, type=${msg.type}, hasMedia=${msg.hasMedia}`);
      const res = await this.checkAndProcess(msg, chat);
      if (res) {
        evaluations.push(res);
      } else {
        evaluations.push({
          msgId: strId,
          type: msg.type,
          body: msg.body,
          reason: 'Tidak lolos validasi atau sudah diproses'
        });
      }
      if (res?.success) {
        extractedItems.push(res);
      }
    }

    this.sendLogs(`[ReimbursementScanner] Selesai scan. Berhasil mengekstrak ${extractedItems.length} set gambar reimbursement.`);
    this.sendLogs(`===================================================================\n`);

    const report = {
      timestamp: new Date().toISOString(),
      success: true,
      candidateCount: candidateMessages.length,
      unhandledCount: unhandledCandidates.length,
      extractedCount: extractedItems.length,
      evaluations,
      items: extractedItems
    };

    return report;
  }

  /**
   * Mengambil identitas pemohon / yang me-request reimbursement
   * (yaitu orang yang mengirimkan pesan nota / struk yang di-reply)
   */
  async resolveRequesterInfo(quotedMsg, chat, mainMsg) {
    let requesterPhone = null;
    let requesterName = null;

    // Jika quotedMsg tidak ada (fallback ke mainMsg)
    const targetMsg = quotedMsg || mainMsg;
    if (!targetMsg) {
      return { senderPhone: null, senderName: 'Unknown' };
    }

    // 1. Dapatkan JID / LID pengirim pesan request (quotedMsg)
    const rawParticipant =
      targetMsg.author ||
      mainMsg?.quotedParticipant ||
      mainMsg?._data?.quotedParticipant ||
      mainMsg?.__x_quotedParticipant ||
      targetMsg.from ||
      (targetMsg.id?._serialized ? targetMsg.id._serialized.split('_')[1] : null) ||
      null;

    let participantJid = null;
    if (typeof rawParticipant === 'string') {
      participantJid = rawParticipant;
    } else if (rawParticipant && typeof rawParticipant === 'object') {
      participantJid = rawParticipant._serialized || rawParticipant.user || String(rawParticipant.id || '');
    }

    // 2. Periksa apakah pesan request dikirim oleh diri sendiri
    const isFromMe = Boolean(
      targetMsg.fromMe ||
      targetMsg.id?.fromMe ||
      (typeof targetMsg.id?._serialized === 'string' && targetMsg.id._serialized.startsWith('true_')) ||
      (typeof mainMsg?.quotedStanzaID === 'string' && mainMsg._data?.quotedMsg?.id?.fromMe)
    );

    if (isFromMe) {
      requesterPhone = this.singleClient.clientInfo?.wid?.user || this.singleClient.client?.info?.wid?.user || null;
      const myPush = this.singleClient.clientInfo?.pushname || this.singleClient.client?.info?.pushname;
      requesterName = myPush ? `Saya (${myPush})` : 'Saya';
      return { senderPhone: requesterPhone, senderName: requesterName };
    }

    // 3. Coba getContact() dari targetMsg atau via client.getContactById
    let contact = null;
    try {
      if (typeof targetMsg.getContact === 'function') {
        contact = await targetMsg.getContact();
      }
    } catch (e) {}

    if (!contact && participantJid && typeof this.singleClient.client?.getContactById === 'function') {
      try {
        contact = await this.singleClient.client.getContactById(participantJid);
      } catch (e) {}
    }

    if (contact) {
      // Prioritas 1: Nama kontak yang disimpan di buku telepon (contact.name / contact.shortName)
      if (contact.name && typeof contact.name === 'string' && contact.name.trim()) {
        requesterName = contact.name.trim();
      } else if (contact.shortName && typeof contact.shortName === 'string' && contact.shortName.trim()) {
        requesterName = contact.shortName.trim();
      } else if (contact.pushname && typeof contact.pushname === 'string' && contact.pushname.trim()) {
        // Prioritas 2: Pushname publik WhatsApp
        requesterName = contact.pushname.trim();
      }

      if (contact.number) {
        requesterPhone = String(contact.number);
      }
    }

    // 4. Cek notifyName dari data quotedMsg atau mainMsg._data.quotedMsg
    if (!requesterName) {
      const nName = targetMsg._data?.notifyName || mainMsg?._data?.quotedMsg?.notifyName || targetMsg._data?.verifiedName;
      if (nName && typeof nName === 'string' && nName.trim()) {
        requesterName = nName.trim();
      }
    }

    // 5. Coba query ContactCollection & ChatCollection di Puppeteer menggunakan participantJid
    if ((!requesterName || requesterName.includes('@lid')) && participantJid && this.singleClient.client?.pupPage) {
      try {
        const puppeteerContact = await this.singleClient.client.pupPage.evaluate((targetId) => {
          const WAWebCollections = window.require?.('WAWebCollections');
          const ContactCollection = WAWebCollections?.Contact;
          const ChatCollection = WAWebCollections?.Chat;

          let c = ContactCollection?.get ? ContactCollection.get(targetId) : null;
          if (!c && ContactCollection?.getModelsArray) {
            c = ContactCollection.getModelsArray().find(x => x.id?._serialized === targetId || x.id?.user === targetId);
          }

          let chatModel = ChatCollection?.get ? ChatCollection.get(targetId) : null;

          return {
            contactName: c?.name || c?.formattedTitle || c?.displayName || c?.pushname || null,
            chatTitle: chatModel?.name || chatModel?.formattedTitle || null,
            phoneNumber: c?.phoneNumber ? (c.phoneNumber.user || c.phoneNumber) : (c?.id?.user && !c?.id?.server?.includes('lid') ? c.id.user : null)
          };
        }, participantJid);

        if (puppeteerContact) {
          if (puppeteerContact.contactName) {
            requesterName = puppeteerContact.contactName;
          } else if (puppeteerContact.chatTitle && !puppeteerContact.chatTitle.includes('@lid') && !puppeteerContact.chatTitle.includes('@c.us')) {
            requesterName = puppeteerContact.chatTitle;
          }
          if (puppeteerContact.phoneNumber && !requesterPhone) {
            requesterPhone = puppeteerContact.phoneNumber;
          }
        }
      } catch (err) {}
    }

    // 6. Jika direct chat (1-on-1) dan requesterName masih belum ketemu, gunakan nama chat
    const isGroup = Boolean(chat?.isGroup || chat?.id?._serialized?.endsWith('@g.us'));
    if (!requesterName && !isGroup && chat) {
      const chatTitle = chat.name || chat.formattedTitle;
      if (chatTitle && !chatTitle.includes('@lid') && !chatTitle.includes('@c.us') && chatTitle !== 'Direct Chat') {
        requesterName = chatTitle;
      }
    }

    // 7. Normalisasi requesterPhone jika masih kosong
    if (!requesterPhone && participantJid) {
      const userPart = typeof participantJid === 'string' && participantJid.includes('@')
        ? participantJid.split('@')[0]
        : String(participantJid || '');
      requesterPhone = userPart || null;
    }

    // 8. Fallback jika requesterName masih kosong atau string JID
    if (!requesterName || requesterName.includes('@lid') || requesterName.includes('@c.us')) {
      requesterName = requesterPhone || 'Pemohon';
    }

    return { senderPhone: requesterPhone, senderName: requesterName };
  }
}

export default ReimbursementTestHandler;
