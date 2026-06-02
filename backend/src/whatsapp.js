const { sendWhatsAppMessage: openwaSend, sendImage: openwaSendImage } = require("./openwaClient");

async function sendWhatsAppMessage(to, text, chatId) {
  return openwaSend(to, text, chatId);
}

async function sendImage(to, imageUrl, caption, chatId) {
  return openwaSendImage(to, imageUrl, caption, chatId);
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
};
