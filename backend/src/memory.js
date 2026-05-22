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
  'service_interest',
  'budget',
  'city',
  'desired_date',
  'lead_status',
  'notes',
])

async function updateCustomerMemory(phone, field, value) {
  if (!ALLOWED_FIELDS.includes(field)) {
    console.warn(`Campo no permitido: ${field}`)
    return
  }

  const fieldIndex = ALLOWED_FIELDS.indexOf(field) + 1

  const setClause = ALLOWED_FIELDS
    .map((f, i) => `${f} = $${i + 1}`)
    .join(', ')

  const values = [
    ...ALLOWED_FIELDS.map(f => f === field ? value : null),
    phone
  ]

  await db.query(
    `UPDATE customers
     SET ${setClause},
         updated_at = NOW()
     WHERE phone = $${ALLOWED_FIELDS.length + 1}`,
    values
  )
}

module.exports = {
  getCustomer,
  createCustomer,
  updateCustomerMemory,
}
