const db = require('./db')

async function getCustomer(phone) {
  const result = await db.query(
    'SELECT * FROM customers WHERE phone = $1 LIMIT 1',
    [phone]
  )

  return result.rows[0]
}

async function createCustomer(phone) {
  await db.query(
    `INSERT INTO customers(phone)
     VALUES($1)
     ON CONFLICT (phone) DO NOTHING`,
    [phone]
  )
}

const ALLOWED_FIELDS = Object.freeze([
  'name',
  'contact_phone',
  'service_interest',
  'budget',
  'city',
  'desired_date',
  'lead_status',
  'notes',
  'flow_state',
  'receipt_image',
  'submitted',
])

async function updateCustomerMemory(phone, field, value) {
  if (!ALLOWED_FIELDS.includes(field)) {
    console.warn(`Campo no permitido: ${field}`)
    return
  }

  await db.query(
    `UPDATE customers
     SET ${field} = $1,
         updated_at = NOW()
     WHERE phone = $2`,
    [value, phone]
  )
}

module.exports = {
  getCustomer,
  createCustomer,
  updateCustomerMemory,
}
