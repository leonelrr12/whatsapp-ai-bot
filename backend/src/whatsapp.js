const axios = require('axios')

const MAX_RETRIES = 3
const RETRY_DELAY = 1000

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, delay = RETRY_DELAY) {
  let lastError
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await sleep(delay * Math.pow(2, i))
    }
  }
  throw lastError
}

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
