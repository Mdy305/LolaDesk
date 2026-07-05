/**
 * lola-agent.js — shared tool-calling loop for Lola.
 * Lets ANY channel (voice, SMS, chat) actually RUN the front-desk skills
 * (check availability, book, reschedule, cancel) instead of only talking
 * about them. Same skills the dashboard chat uses, via executeSkill().
 *
 * runLolaAgentReply() is fail-safe: on any error it returns { ok:false } so
 * the caller can fall back to its existing reply — a bug here can never take
 * the front desk offline.
 */
import { chat } from "./llm.js";
import { SKILLS } from "../lola-tools.js";
import { executeSkill } from "./orchestrator.js";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "book_appointment",
      description: "Book an appointment for a client.",
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", description: "The service to book (e.g. balayage)" },
          date: { type: "string", description: "Date like 2026-06-25" },
          time: { type: "string", description: "Time like 14:00" },
          client_name: { type: "string" },
          client_phone: { type: "string" }
        },
        required: ["service", "client_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_services",
      description: "List all services offered by the salon.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_pricing",
      description: "Get pricing and duration for a specific service.",
      parameters: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check if the salon has openings for a service.",
      parameters: {
        type: "object",
        properties: { service: { type: "string" }, date: { type: "string" } },
        required: ["service"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "confirm_booking",
      description: "Confirm a client's upcoming booking by phone or name.",
      parameters: {
        type: "object",
        properties: {
          client_phone: { type: "string" },
          client_name: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reschedule_appointment",
      description: "Reschedule an existing appointment to a new date/time.",
      parameters: {
        type: "object",
        properties: {
          booking_id: { type: "string" },
          client_phone: { type: "string" },
          new_date: { type: "string", description: "Date like 2026-06-25" },
          new_time: { type: "string", description: "Time like 14:00 or 2:00 PM" }
        },
        required: ["new_date", "new_time"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancel an existing appointment.",
      parameters: {
        type: "object",
        properties: {
          booking_id: { type: "string" },
          client_phone: { type: "string" }
        }
      }
    }
  }
];

export async function runLolaAgentReply({ tenant, clientPhone, channel = "sms", system, messages, maxTokens = 280 }){
  try{
    if(!tenant || !Array.isArray(messages)) return { ok:false };
    const convo = messages.slice();

    let result = await chat({ system, messages: convo, maxTokens, temperature: 0.5, tools: TOOLS, source: channel });
    if(!result.ok) return { ok:false };

    if(result.tool_calls && result.tool_calls.length){
      const call = result.tool_calls[0];
      const name = call.function && call.function.name;
      let args = {};
      try{ args = JSON.parse((call.function && call.function.arguments) || "{}"); }catch{}
      if(clientPhone && !args.client_phone) args.client_phone = clientPhone;

      let toolResult;
      try{
        toolResult = SKILLS[name]
          ? await executeSkill(tenant, args.client_phone, name, args, SKILLS)
          : { error: "unknown skill: " + name };
      }catch(e){ toolResult = { error: String(e && e.message || e) }; }

      convo.push({ role: "assistant", content: null, tool_calls: result.tool_calls });
      convo.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(toolResult) });

      const second = await chat({ system, messages: convo, maxTokens, temperature: 0.5, tools: TOOLS, source: channel });
      if(second.ok) result = second;
    }

    const text = String(result.text || "").trim();
    return text ? { ok:true, text } : { ok:false };
  }catch(e){
    return { ok:false, error: String(e && e.message || e) };
  }
}

