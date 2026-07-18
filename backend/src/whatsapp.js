const { sendWhatsAppMessage: baileysSend, sendImage: baileysSendImage } = require("./baileysClient");

async function sendWhatsAppMessage(to, text, chatId, sessionId) {
  return baileysSend(to, text, chatId, sessionId);
}

async function sendImage(to, imageUrl, caption, chatId, sessionId) {
  return baileysSendImage(to, imageUrl, caption, chatId, sessionId);
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
};
