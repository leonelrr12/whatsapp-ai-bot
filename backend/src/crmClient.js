const axios = require('axios')
const { sendWhatsAppMessage } = require('./whatsapp')

const CRM_API_URL = process.env.CRM_API_URL || 'http://host.docker.internal:3001'
const NOTIFY_GROUP = process.env.CRM_NOTIFY_GROUP || ''

function formatMessage(customer) {
  const lines = [
    '🆕 *Nuevo Lead - WhatsApp*',
    '',
    `👤 *Nombre:* ${customer.name || 'No indicado'}`,
    `📱 *Teléfono:* ${customer.contact_phone || customer.phone || 'No indicado'}`,
    `🔧 *Servicio:* ${customer.service_interest || 'No indicado'}`,
    `📍 *Ciudad:* ${customer.city || 'No indicado'}`,
    `💰 *Presupuesto:* ${customer.budget || 'No indicado'}`,
  ]
  if (customer.notes) lines.push(`📝 *Notas:* ${customer.notes}`)
  lines.push('', `✅ Registrado en CRM`)
  return lines.join('\n')
}

async function syncLeadToCRM(customer) {
  console.log('=== CRM LEAD SYNC START ===')
  console.log('Customer phone:', customer?.phone)

  try {
    const payload = {
      name: customer.name || '',
      phone: customer.phone || '',
      contactPhone: customer.contact_phone || '',
      email: customer.email || '',
      serviceInterest: customer.service_interest || '',
      city: customer.city || '',
      budget: customer.budget || '',
      notes: customer.notes || '',
      receiptImage: customer.receipt_image || '',
      source: 'whatsapp',
    }

    const response = await axios.post(`${CRM_API_URL}/api/public/lead`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    })

    console.log('Lead enviado al CRM:', response.status, response.data?.lead?.id)

    if (NOTIFY_GROUP) {
      const chatId = `${NOTIFY_GROUP}@g.us`
      const msg = formatMessage(customer)
      await sendWhatsAppMessage(NOTIFY_GROUP, msg, chatId)
      console.log('Notificación enviada al grupo')
    }
  } catch (error) {
    if (error.response) {
      console.error('Error del CRM:', error.response.status, JSON.stringify(error.response.data))
    } else {
      console.error('Error conectando al CRM:', error.message)
    }
  }

  console.log('=== CRM LEAD SYNC END ===')
}

module.exports = { syncLeadToCRM }
