const axios = require("axios");

async function appendToGoogleSheet(customer) {
  console.log("=== GOOGLE SHEETS START ===");
  console.log("Customer phone:", customer?.phone);

  try {
    const scriptUrl = process.env.APPS_SCRIPT_URL;
    console.log(
      "APPS_SCRIPT_URL:",
      scriptUrl ? "Configurado" : "NO CONFIGURADO",
    );

    if (!scriptUrl) {
      console.log("APPS_SCRIPT_URL no configurado, omitiendo");
      return;
    }

    const data = {
      origen: "WS",
      fechaActual: new Date().toISOString(),
      telefono: customer.phone || "",
      nombre: customer.name || "",
      recibo: customer.receipt_image || "",
      monto_rec: customer.budget || "",
      servicio: customer.service_interest || "",
      ubicacion: customer.city || "",
      notas: customer.notes || "",

      email: "No indicado",
      residencia: "No indicado",
      plano: "No indicado",
      consulta: "",
    };

    console.log("Datos a enviar:", JSON.stringify(data));

    const response = await axios.post(scriptUrl, data, {
      headers: { "Content-Type": "application/json" },
    });

    console.log("Respuesta Apps Script:", response.status, response.data);
    console.log("Datos enviados a Apps Script correctamente");
  } catch (error) {
    console.error("Error enviando a Apps Script:", error.message);
    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    }
  }
  console.log("=== GOOGLE SHEETS END ===");
}

module.exports = { appendToGoogleSheet };
