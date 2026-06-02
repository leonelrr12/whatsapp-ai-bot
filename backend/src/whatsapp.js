const { sendWhatsAppMessage: openwaSend, sendImage: openwaSendImage } = require("./openwaClient");

async function sendWhatsAppMessage(to, text) {
  return openwaSend(to, text);
}

async function sendImage(to, imageUrl, caption) {
  return openwaSendImage(to, imageUrl, caption);
}

module.exports = {
  sendWhatsAppMessage,
  sendImage,
};
