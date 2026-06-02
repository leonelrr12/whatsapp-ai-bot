const axios = require('axios')
const { retryWithBackoff } = require('./utils')

async function sendWhatsAppMessage(to, text) {
  try {
    await retryWithBackoff(async () => {
      await axios.post(
        `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
        {
          messaging_product: 'whatsapp',
          to,
          text: {
            body: text,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      )
    })
  } catch (error) {
    console.error('Error enviando mensaje WhatsApp:', error.response?.data || error.message)
    throw error
  }
}

module.exports = {
  sendWhatsAppMessage,
}
