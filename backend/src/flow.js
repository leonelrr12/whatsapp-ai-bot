const { getCustomer, updateCustomerMemory } = require('./memory');

const FLOW_STATES = {
  GREETING: 'greeting',
  SERVICE: 'service',
  NAME: 'name',
  CITY: 'city',
  BUDGET: 'budget',
  PHONE: 'phone',
  COMPLETE: 'complete',
  AI_MODE: 'ai_mode'
};

const WELCOME_MESSAGE = `¡Hola! 👋 Bienvenido a **Green Energy Technology**

Somos expertos en energía solar fotovoltaica. Estamos aquí para ayudarte aAHORRAR en tu factura de luz.

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
    1: { next: FLOW_STATES.NAME, service: 'paneles residenciales', text: 'Excelente elección 🏠 Los paneles residenciales pueden ahorrarte hasta un 90% en tu factura de luz.\n\n**¿Cuál es tu nombre completo?**' },
    2: { next: FLOW_STATES.NAME, service: 'paneles comerciales', text: 'Excelente elección 🏢 Para empresas, los paneles solares reducen significativamente los costos operativos.\n\n**¿Cuál es tu nombre completo?**' },
    3: { next: FLOW_STATES.NAME, service: 'baterías', text: 'Las baterías de respaldo te dan energía cuando la necesitas 🔋\n\n**¿Cuál es tu nombre completo?**' },
    4: { next: FLOW_STATES.NAME, service: 'mantenimiento', text: 'El mantenimiento asegura el máximo rendimiento de tu sistema 🔧\n\n**¿Cuál es tu nombre completo?**' },
    5: { next: FLOW_STATES.AI_MODE, text: 'Perfecto, con gusto te informamos. ¿Cuál es tu pregunta?' }
  },
  [FLOW_STATES.NAME]: {
    default: { next: FLOW_STATES.CITY, text: '¡Gracias, {name}! 📍\n\n**¿En qué ciudad o zona estás ubicados?**' }
  },
  [FLOW_STATES.CITY]: {
    default: { next: FLOW_STATES.BUDGET, text: 'Perfecto 💰\n\n**¿Cuál es tu consumo promedio mensual de luz? (aproximado en $)**\n\nEjemplo: $150, $200, $300' }
  },
  [FLOW_STATES.BUDGET]: {
    default: { next: FLOW_STATES.PHONE, text: 'Gracias por la información 📱\n\n**¿Nos puedes proporcionar un número de teléfono paracontactarte y agendar la inspección técnica?**\n\nLa inspección es gratuita y sin compromiso.' }
  },
  [FLOW_STATES.PHONE]: {
    default: { next: FLOW_STATES.COMPLETE, text: '¡Perfecto! ✅\n\nHe recibido todos tus datos. Un asesor técnico te contactará en las próximas horas para:\n\n• Confirmar tu cotización\n• Programar la inspección técnica gratuita\n• Resolver cualquier duda\n\n**¿Tienes alguna pregunta adicional?**' }
  },
  [FLOW_STATES.COMPLETE]: {
    default: { next: FLOW_STATES.COMPLETE, text: 'Gracias por contactarnos ✅\n\nUn asesor te contactará pronto. Mientras tanto, puedes ver más información en nuestra página web.\n\n¿Hay algo más en lo que pueda ayudarte?' }
  }
};

function getFlowResponse(state, message, customer) {
  const lower = message.toLowerCase();
  
  if (state === FLOW_STATES.GREETING || state === FLOW_STATES.AI_MODE) {
    const option = message.trim();
    if (RESPONSES[state][option]) {
      return RESPONSES[state][option];
    }
  }
  
  if (state === FLOW_STATES.NAME && customer) {
    const name = message.trim();
    const response = { ...RESPONSES[state].default };
    response.text = response.text.replace('{name}', name);
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
  
  // Check if this is the first message (show welcome AND process the selection)
  if (currentState === FLOW_STATES.GREETING) {
    const option = text.trim();
    const greetingOption = RESPONSES[FLOW_STATES.GREETING][option];
    
    if (greetingOption) {
      // Valid option selected - save service and move to NAME
      if (greetingOption.service) {
        await updateCustomerMemory(phone, 'service_interest', greetingOption.service);
      }
      await updateCustomerMemory(phone, 'flow_state', FLOW_STATES.NAME);
      return { text: greetingOption.text, nextState: FLOW_STATES.NAME };
    }
    
    // No valid option - just show welcome message
    return { text: WELCOME_MESSAGE, nextState: FLOW_STATES.GREETING };
  }
  
  if (currentState === FLOW_STATES.COMPLETE && text.length < 20) {
    const response = RESPONSES[FLOW_STATES.COMPLETE].default;
    return { text: response.text, nextState: FLOW_STATES.COMPLETE };
  }
  
  const flowResponse = getFlowResponse(currentState, text, customer);
  
  if (!flowResponse) {
    return { 
      text: 'Disculpa, no entendí. ¿Podrías responder con el número de la opción?', 
      nextState: currentState 
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
    responseText = responseText.replace('{name}', name);
    await updateCustomerMemory(phone, 'name', name);
  }
  if (currentState === FLOW_STATES.CITY) {
    await updateCustomerMemory(phone, 'city', text.trim());
  }
  if (currentState === FLOW_STATES.BUDGET) {
    await updateCustomerMemory(phone, 'budget', text.trim());
  }
  if (currentState === FLOW_STATES.PHONE) {
    await updateCustomerMemory(phone, 'notes', `Teléfono adicional: ${text.trim()}`);
  }
  
  await updateCustomerMemory(phone, 'flow_state', newState);
  
  return { text: responseText, nextState: newState };
}

function resetFlow(phone) {
  return updateCustomerMemory(phone, 'flow_state', FLOW_STATES.GREETING);
}

module.exports = {
  FLOW_STATES,
  WELCOME_MESSAGE,
  processMessage,
  resetFlow
};