const { sendWhatsAppMessage: openwaSend, sendImage: openwaSendImage } = require("./openwaClient");

async function sendWhatsAppMessage(to, text, chatId, sessionId) {
  return openwaSend(to, text, chatId, sessionId);
}

async function sendImage(to, imageUrl, caption, chatId, sessionId) {
  return openwaSendImage(to, imageUrl, caption, chatId, sessionId);
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
};
