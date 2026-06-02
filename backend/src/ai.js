const axios = require("axios");
const { systemPrompt } = require("./prompts");
const { retryWithBackoff } = require("./utils");

function buildMemoryContext(memory) {
  return `
Nombre: ${memory.name || "No disponible"}
Servicio: ${memory.service_interest || "No disponible"}
Ciudad: ${memory.city || "No disponible"}
Presupuesto: ${memory.budget || "No disponible"}
Fecha deseada: ${memory.desired_date || "No disponible"}
Estado lead: ${memory.lead_status || "nuevo"}
  `.trim();
}

async function askAI(message, memory = {}) {
  const memoryContext = buildMemoryContext(memory);
  const fullSystemPrompt = `${systemPrompt}\n\n### CONTEXTO DEL CLIENTE:\n${memoryContext}`;

  console.log("Consultando IA con:", message);
  console.log("System prompt:", fullSystemPrompt.substring(0, 100) + "...");
  
  try {
    const response = await retryWithBackoff(async () => {
      return await axios.post(`${process.env.OLLAMA_URL}/api/chat`, {
        model: process.env.MODEL,
        messages: [
          { role: "system", content: fullSystemPrompt },
          { role: "user", content: message },
        ],
        stream: false,
        options: {
          num_predict: 200,
          temperature: 0.3,
        },
      });
    });

    const content = response.data.message?.content;
    console.log("Respuesta IA recibida:", content ? "SI" : "VACIA");
    
    if (!content || content.trim() === "") {
      console.warn("IA respondió vacío, usando mensaje por defecto");
      return "Gracias por contactarnos. Un asesor te contactará pronto para ayudarte con tu cotización de energía solar.";
    }
    
    return content;
  } catch (error) {
    console.error("Error en askAI:", error.message);
    return "Ocurrió un error procesando tu mensaje. Por favor, intenta más tarde.";
  }
}

module.exports = {
  askAI,
};
