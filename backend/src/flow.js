const { getCustomer, updateCustomerMemory } = require("./memory");

const FLOW_STATES = {
  GREETING: "greeting",
  SERVICE_INFO: "service_info",
  NAME: "name",
  PHONE: "phone",
  CITY: "city",
  BUDGET: "budget",
  ADDITIONAL_INFO: "additional_info",
  IMAGE: "image",
  COMPLETE: "complete",
  END: "end",
  AI_MODE: "ai_mode",
};

const WELCOME_MESSAGE = `¡Hola! 👋 Bienvenido a *Green Energy Technology*

Somos expertos en energía solar fotovoltaica. Estamos aquí para ayudarte a **ahorrar** en tu factura de luz.

Para comenzar tu cotización sin compromiso, necesito algunos datos:

**¿Qué tipo de servicio te interesa?**
1. 🏠 Paneles solares residenciales
2. 🏢 Paneles solares comerciales
3. 🔋 Baterías de respaldo
4. 🔧 Mantenimiento de sistema existente
5. ❓ Información general

Responde con el número de tu interés:`;

const RESPONSES = {
  [FLOW_STATES.GREETING]: {
    1: {
      next: FLOW_STATES.NAME,
      service: "paneles residenciales",
      text: "Excelente elección 🏠 Los paneles residenciales pueden ahorrarte hasta un 90% en tu factura de luz.\n\n**¿Cuál es tu nombre completo?**",
    },
    2: {
      next: FLOW_STATES.NAME,
      service: "paneles comerciales",
      text: "Excelente elección 🏢 Para empresas, los paneles solares reducen significativamente los costos operativos.\n\n**¿Cuál es tu nombre completo?**",
    },
    3: {
      next: FLOW_STATES.NAME,
      service: "baterías",
      text: "Las baterías de respaldo te dan energía cuando la necesitas 🔋\n\n**¿Cuál es tu nombre completo?**",
    },
    4: {
      next: FLOW_STATES.NAME,
      service: "mantenimiento",
      text: "El mantenimiento asegura el máximo rendimiento de tu sistema 🔧\n\n**¿Cuál es tu nombre completo?**",
    },
    5: {
      next: FLOW_STATES.SERVICE_INFO,
      text: "Para darte la mejor información, ¿qué tipo de servicio te interesa?\n\n1. 🏠 Residencial\n2. 🏢 Comercial\n3. 🔋 Baterías\n4. 🔧 Mantenimiento",
    },
  },
  [FLOW_STATES.SERVICE_INFO]: {
    1: {
      next: FLOW_STATES.NAME,
      service: "paneles residenciales",
      text: "Perfecto 🏠 Los paneles residenciales pueden ahorrarte hasta un 90% en tu factura de luz.\n\n**¿Cuál es tu nombre completo?**",
    },
    2: {
      next: FLOW_STATES.NAME,
      service: "paneles comerciales",
      text: "Perfecto 🏢 Los paneles comerciales reducen significativamente los costos operativos.\n\n**¿Cuál es tu nombre completo?**",
    },
    3: {
      next: FLOW_STATES.NAME,
      service: "baterías",
      text: "Las baterías de respaldo te dan energía cuando la necesitas 🔋\n\n**¿Cuál es tu nombre completo?**",
    },
    4: {
      next: FLOW_STATES.NAME,
      service: "mantenimiento",
      text: "El mantenimiento asegura el máximo rendimiento de tu sistema 🔧\n\n**¿Cuál es tu nombre completo?**",
    },
  },
  [FLOW_STATES.NAME]: {
    default: {
      next: FLOW_STATES.PHONE,
      text: "¡Gracias, {name}! 📱\n\n**¿Cuál es tu número de teléfono para contactarte?**\n\n*(Sin el prefijo +507, solo los 8 dígitos)*\n\nEjemplo: 6000-0000",
    },
  },
  [FLOW_STATES.PHONE]: {
    default: {
      next: FLOW_STATES.CITY,
      text: "Perfecto 📍\n\n**¿En qué ciudad o zona estás ubicado?**",
    },
  },
  [FLOW_STATES.CITY]: {
    default: {
      next: FLOW_STATES.BUDGET,
      text: "Perfecto 💰\n\n**¿Cuál es tu consumo promedio mensual de luz? (aproximado en $)**\n\nEjemplo: $150, $200, $300",
    },
  },
  [FLOW_STATES.BUDGET]: {
    default: {
      next: FLOW_STATES.ADDITIONAL_INFO,
      text: 'Gracias por la información 📱\n\n**¿Hay alguna información adicional que quieras proporcionarnos?**\n\nPor ejemplo: tipo de techo, si tienes planos de la casa o local, etc.\n\n(O si no tienes más información, solo dime "no")',
    },
  },
  [FLOW_STATES.ADDITIONAL_INFO]: {
    default: {
      next: FLOW_STATES.IMAGE,
      text: '📸 **Opcional:** Si tienes a mano Recibo de luz, toma una foto de la parte que muestra el consumo de los últimos meses. Nos ayudará en el cálculo más preciso de tu ahorro.\n\n(Si no tienes el Recibo, solo dime "no")',
    },
  },
  [FLOW_STATES.IMAGE]: {
    default: {
      next: FLOW_STATES.COMPLETE,
      text: "¡Perfecto! ✅\n\nHe recibido todos tus datos. Un asesor técnico te contactará en las próximas horas para:\n\n• Confirmar tu cotización\n• Programar la inspección técnica gratuita\n• Resolver cualquier duda\n\nEsta Usted de acuerdo?.",
    },
  },
  [FLOW_STATES.COMPLETE]: {
    default: {
      next: FLOW_STATES.COMPLETE,
      text: "Gracias por contactarnos ✅\n\nUn asesor te contactará pronto. Mientras tanto, puedes ver más información en nuestra página web: *www.greenenergytechnologie.com*",
    },
    no: {
      next: FLOW_STATES.END,
      text: "¡Gracias por tu tiempo! 😊\n\nUn asesor se comunicará contigo pronto para darte seguimiento.\n\n¡Que tengas un excelente día! 🌞",
    },
    si: {
      next: FLOW_STATES.COMPLETE,
      text: "Claro, dime tu pregunta y con gusto te ayudaré.",
    },
  },
  [FLOW_STATES.END]: {
    default: {
      next: FLOW_STATES.END,
      text: '¡Gracias! 🙌 Puedes escribir "Hola" si necesitas ayuda en el futuro. ¡Hasta luego! 🌞',
    },
  },
};

function getFlowResponse(state, message, customer) {
  const lower = message.toLowerCase();
  const option = message.trim();

  if (
    state === FLOW_STATES.GREETING ||
    state === FLOW_STATES.COMPLETE ||
    state === FLOW_STATES.SERVICE_INFO ||
    state === FLOW_STATES.AI_MODE
  ) {
    if (RESPONSES[state][option]) {
      return RESPONSES[state][option];
    }
  }

  if (state === FLOW_STATES.NAME && customer) {
    const name = message.trim();
    const response = { ...RESPONSES[state].default };
    response.text = response.text.replace("{name}", name);
    return response;
  }

  if (RESPONSES[state]?.default) {
    return RESPONSES[state].default;
  }

  return null;
}

async function processMessage(phone, text, useAI = false) {
  const customer = await getCustomer(phone);
  const currentState = customer?.flow_state || FLOW_STATES.GREETING;

  if (useAI) {
    return { useAI: true };
  }

  // Allow restarting from END state with a greeting
  if (currentState === FLOW_STATES.END) {
    const greetings = ["hola", "hola!", "hola.", "hi", "hi!", "hello", "hello!", "buenos días", "buenos dias", "buenas tardes", "buenas noches", "hola de nuevo", "reiniciar", "empezar de nuevo"];
    if (greetings.includes(text.toLowerCase().trim())) {
      await updateCustomerMemory(phone, "flow_state", FLOW_STATES.GREETING);
      await updateCustomerMemory(phone, "submitted", "false");
      return { text: WELCOME_MESSAGE, nextState: FLOW_STATES.GREETING };
    }
  }

  // Check if this is the first message (show welcome AND process the selection)
  if (currentState === FLOW_STATES.GREETING) {
    const option = text.trim();
    const greetingOption = RESPONSES[FLOW_STATES.GREETING][option];

    if (greetingOption) {
      // Save service if applicable
      if (greetingOption.service) {
        await updateCustomerMemory(
          phone,
          "service_interest",
          greetingOption.service,
        );
      }

      // Save the new state
      const newState = greetingOption.next;
      await updateCustomerMemory(phone, "flow_state", newState);

      return { text: greetingOption.text, nextState: newState };
    }

    return { text: WELCOME_MESSAGE, nextState: FLOW_STATES.GREETING };
  }

  // Handle SERVICE_INFO state (when user didn't choose 1-4 initially)
  if (currentState === FLOW_STATES.SERVICE_INFO) {
    console.log("=== SERVICE_INFO STATE ===");
    console.log("Current state:", currentState);
    console.log("Text received:", text);

    const option = text.trim();
    console.log("Option:", option);
    console.log(
      "Available options:",
      Object.keys(RESPONSES[FLOW_STATES.SERVICE_INFO]),
    );

    const serviceOption = RESPONSES[FLOW_STATES.SERVICE_INFO][option];
    console.log("Found option:", !!serviceOption);

    if (serviceOption) {
      console.log("Service to save:", serviceOption.service);
      if (serviceOption.service) {
        await updateCustomerMemory(
          phone,
          "service_interest",
          serviceOption.service,
        );
      }
      await updateCustomerMemory(phone, "flow_state", FLOW_STATES.NAME);
      console.log(
        "Saved flow_state to NAME, returning text:",
        serviceOption.text,
      );

      // Return directly with the text from serviceOption, don't go through getFlowResponse
      return { text: serviceOption.text, nextState: FLOW_STATES.NAME };
    }

    return {
      text: "Disculpa, ¿podrías responder con el número de la opción (1-4)?",
      nextState: FLOW_STATES.SERVICE_INFO,
    };
  }

  const flowResponse = getFlowResponse(currentState, text, customer);

  if (!flowResponse) {
    return {
      text: "Disculpa, no entendí. ¿Podrías responder con el número de la opción?",
      nextState: currentState,
    };
  }

  if (flowResponse.useAI) {
    return { useAI: true };
  }

  const newState = flowResponse.next;
  let responseText = flowResponse.text;

  // Save data based on current state
  if (currentState === FLOW_STATES.NAME) {
    const name = text.trim();
    responseText = responseText.replace("{name}", name);
    await updateCustomerMemory(phone, "name", name);
  }
  if (currentState === FLOW_STATES.PHONE) {
    const rawPhone = text.trim().replace(/[^0-9]/g, "");
    if (rawPhone.length !== 8) {
      return {
        text: "❌ El número debe tener exactamente **8 dígitos** (sin el prefijo +507).\n\nEjemplo: 6000-0000\n\n**Intenta de nuevo:**",
        nextState: currentState,
      };
    }
    const fullPhone = `+507${rawPhone}`;
    await updateCustomerMemory(phone, "contact_phone", fullPhone);
  }
  if (currentState === FLOW_STATES.CITY) {
    await updateCustomerMemory(phone, "city", text.trim());
  }
  if (currentState === FLOW_STATES.BUDGET) {
    await updateCustomerMemory(phone, "budget", text.trim());
  }
  if (currentState === FLOW_STATES.ADDITIONAL_INFO) {
    const lower = text.toLowerCase();
    if (
      lower === "no" ||
      lower === "continuar" ||
      lower === "ninguna" ||
      lower === "nada"
    ) {
      // No additional info provided, leave notes empty or with existing info
    } else {
      await updateCustomerMemory(phone, "notes", text.trim());
    }
  }
  if (currentState === FLOW_STATES.IMAGE) {
    const lower = text.toLowerCase();
    if (
      lower !== "imagen_recibida" &&
      lower !== "continuar" &&
      lower !== "no" &&
      lower !== "ninguna"
    ) {
      const customer = await getCustomer(phone);
      const existingNotes = customer?.notes || "";
      const newNotes = existingNotes
        ? `${existingNotes}\n${text.trim()}`
        : text.trim();
      await updateCustomerMemory(phone, "notes", newNotes);
    }
  }

  await updateCustomerMemory(phone, "flow_state", newState);

  return { text: responseText, nextState: newState };
}

function resetFlow(phone) {
  return updateCustomerMemory(phone, "flow_state", FLOW_STATES.GREETING);
}

module.exports = {
  FLOW_STATES,
  WELCOME_MESSAGE,
  processMessage,
  resetFlow,
};
