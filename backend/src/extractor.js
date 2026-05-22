function extractCustomerData(message) {
  const data = {}

  const lower = message.toLowerCase()

  if (lower.includes('panel')) {
    data.service_interest = 'paneles solares'
  }

  if (lower.includes('bateria')) {
    data.service_interest = 'baterías'
  }

  if (lower.includes('mantenimiento')) {
    data.service_interest = 'mantenimiento'
  }

  const nameMatch = message.match(/me llamo\s+([a-zA-Z]+)/i)

  if (nameMatch) {
    data.name = nameMatch[1]
  }

  return data
}

module.exports = {
  extractCustomerData,
}
