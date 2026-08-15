/**
 * api/lib/telnyx-mcp-integration.js — Native MCP (Model Context Protocol) Server
 * ════════════════════════════════════════════════════════════════════════════
 * Telnyx integrates natively with MCP Servers. Lola's tools are MCP-native,
 * allowing direct connection to 1000+ third-party services without custom code.
 *
 * SUPPORTED INTEGRATIONS (via MCP):
 * - Google Calendar (read availability, create events)
 * - Stripe (check balance, process payments)
 * - Slack (notify team of bookings)
 * - Salesforce (log client activity)
 * - HubSpot (update CRM)
 * - Shopify (inventory sync)
 * - Zapier (trigger workflows)
 *
 * USAGE:
 * LLM calls tool: { name: "calendar_check_availability", params: { date: "2026-06-24" } }
 * MCP Server intercepts → queries Google Calendar → returns slots
 * LLM sees response immediately, no custom code needed
 */

import { runBookingAction } from './booking-brain.js';
import { getTenantById } from './operator-db.js';

// The voice/SMS transports resolve tenant.id before the LLM runs; MCP tool
// calls receive that id and must turn it back into a tenant row before the
// booking brain can act on it. Null means the tool cannot safely run.
async function tenantForMCP(tenantId){
  if(!tenantId) return null;
  try{ return await getTenantById(tenantId); }catch{ return null; }
}

const MCPToolDefinitions = {
  calendar: {
    name: 'calendar_check_availability',
    description: 'Check stylist availability from connected Google Calendar',
    inputSchema: {
      type: 'object',
      properties: {
        stylist_name: { type: 'string', description: 'Stylist name' },
        date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
        duration_min: { type: 'number', description: 'Duration in minutes' }
      },
      required: ['date']
    }
  },

  calendar_create: {
    name: 'calendar_create_booking',
    description: 'Create a booking directly in connected calendar (Google, Outlook)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Appointment title' },
        start_time: { type: 'string', description: 'ISO 8601 start time' },
        end_time: { type: 'string', description: 'ISO 8601 end time' },
        stylist_email: { type: 'string', description: 'Stylist email for calendar' },
        client_email: { type: 'string', description: 'Client email (optional)' },
        description: { type: 'string', description: 'Service details' }
      },
      required: ['title', 'start_time', 'end_time']
    }
  },

  stripe_charge: {
    name: 'stripe_charge_client',
    description: 'Process payment via connected Stripe account',
    inputSchema: {
      type: 'object',
      properties: {
        amount_cents: { type: 'number', description: 'Amount in cents ($50 = 5000)' },
        client_id: { type: 'string', description: 'Salon client ID (customer lookup)' },
        description: { type: 'string', description: 'Payment description (deposit, service)' },
        idempotency_key: { type: 'string', description: 'Unique key to prevent duplicates' }
      },
      required: ['amount_cents', 'description']
    }
  },

  stripe_balance: {
    name: 'stripe_get_balance',
    description: 'Get Stripe account balance and recent transactions',
    inputSchema: {
      type: 'object',
      properties: {
        last_n_transactions: { type: 'number', description: 'How many recent transactions to show' }
      }
    }
  },

  crm_update: {
    name: 'crm_update_client',
    description: 'Update client record in connected CRM (HubSpot, Salesforce, Pipedrive)',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client ID in CRM' },
        fields: {
          type: 'object',
          description: 'Fields to update (e.g., { last_service_date, lifetime_value, tags })'
        }
      },
      required: ['client_id', 'fields']
    }
  },

  crm_search: {
    name: 'crm_search_client',
    description: 'Search client in CRM by phone, email, or name',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Phone, email, or client name' },
        fields: { type: 'array', description: 'Fields to return (phone, email, lifetime_value, last_booking)' }
      },
      required: ['query']
    }
  },

  slack_notify: {
    name: 'slack_notify_team',
    description: 'Send Slack notification to team channel (new booking, cancellation, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: '#bookings, #team, #alerts' },
        message: { type: 'string', description: 'Message text' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Alert level' }
      },
      required: ['channel', 'message']
    }
  },

  email_send: {
    name: 'email_send_client',
    description: 'Send email to client (confirmation, invoice, follow-up)',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Client email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (HTML supported)' },
        template: { type: 'string', description: 'Optional template name (booking_confirmation, invoice)' }
      },
      required: ['to', 'subject', 'body']
    }
  },

  sms_send: {
    name: 'sms_send_client',
    description: 'Send SMS to client (confirmation, reminder, follow-up)',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Client phone number' },
        message: { type: 'string', description: 'SMS text (max 160 chars recommended)' }
      },
      required: ['to', 'message']
    }
  },

  inventory_check: {
    name: 'inventory_check_stock',
    description: 'Check product inventory from connected system (Shopify, custom DB)',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Product SKU' },
        product_name: { type: 'string', description: 'Product name (alternative to SKU)' }
      }
    }
  },

  analytics_get: {
    name: 'analytics_get_metrics',
    description: 'Retrieve KPI metrics (bookings this month, revenue, churn rate)',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['bookings_this_month', 'revenue', 'churn_rate', 'avg_rating', 'no_show_rate'] },
        time_period: { type: 'string', enum: ['today', 'week', 'month', 'quarter'] }
      },
      required: ['metric']
    }
  },

  zapier_trigger: {
    name: 'zapier_trigger_workflow',
    description: 'Trigger Zapier workflow for external automation (send to external CRM, create task, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        webhook_key: { type: 'string', description: 'Zapier webhook key' },
        data: {
          type: 'object',
          description: 'Workflow data (client_name, booking_date, service, etc.)'
        }
      },
      required: ['webhook_key', 'data']
    }
  },

  // ── LolaDesk native booking + memory tools (the REAL smart booking path) ──
  lola_check_availability: {
    name: 'lola_check_availability',
    description: 'Check real appointment availability in this salon\'s calendar for a service and optional stylist/date',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name or id' },
        stylist: { type: 'string', description: 'Stylist name (optional)' },
        date: { type: 'string', description: 'Date YYYY-MM-DD (optional, defaults to today)' }
      }
    }
  },

  lola_book_appointment: {
    name: 'lola_book_appointment',
    description: 'Book a confirmed appointment: resolves service/stylist, holds the slot, commits, and remembers it',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name' },
        stylist: { type: 'string', description: 'Stylist name (optional)' },
        date: { type: 'string', description: 'Date YYYY-MM-DD or "tomorrow"' },
        time: { type: 'string', description: 'Time, e.g. "2:00 PM"' },
        client_name: { type: 'string', description: "Caller's name" },
        client_phone: { type: 'string', description: "Caller's phone" },
        notes: { type: 'string', description: 'Notes for the appointment' }
      },
      required: ['service']
    }
  },

  lola_reschedule_appointment: {
    name: 'lola_reschedule_appointment',
    description: 'Reschedule an existing appointment to a new time (availability-checked)',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: 'Existing booking id' },
        starts_at: { type: 'string', description: 'New ISO 8601 start time' }
      },
      required: ['booking_id', 'starts_at']
    }
  },

  lola_cancel_appointment: {
    name: 'lola_cancel_appointment',
    description: 'Cancel an existing appointment and free the slot',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', description: 'Booking id to cancel' },
        reason: { type: 'string', description: 'Cancellation reason' }
      },
      required: ['booking_id']
    }
  },

  lola_remember: {
    name: 'lola_remember',
    description: 'Save a fact about this salon or a client into Lola\'s per-tenant memory for later recall',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short label for the fact' },
        value: { type: 'string', description: 'What to remember' }
      },
      required: ['key']
    }
  },

  lola_recall: {
    name: 'lola_recall',
    description: 'Recall what Lola remembers for this salon (or a specific key)',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Optional key to recall just one memory' }
      }
    }
  }
};

/**
 * Register all MCP tools in Lola's system prompt
 * Telnyx will intercept these tool calls and route to MCP server
 */
export function buildMCPToolsPrompt() {
  const tools = Object.values(MCPToolDefinitions);
  return `
AVAILABLE MCP TOOLS (Connected via Telnyx):
${tools.map(t => `
- ${t.name}
  Description: ${t.description}
  Schema: ${JSON.stringify(t.inputSchema, null, 2)}
`).join('\n')}

When you need to check availability, create bookings, process payments, update CRM, send emails, or access any external system:
1. Call the appropriate MCP tool (e.g., calendar_check_availability)
2. Provide parameters as specified in the schema
3. MCP server handles authentication and API calls
4. You receive the result and respond to the client immediately

Do NOT attempt to make raw HTTP requests. Always use MCP tools.
`;
}

/**
 * MCP Tool Execution Handler
 * When LLM calls a tool, this intercepts and routes to the appropriate backend
 */
export async function executeMCPTool(toolName, params, tenantId) {
  // The LLM emits the tool's `.name` (e.g. "lola_book_appointment"), while the
  // definitions are keyed by a shorthand. Resolve by name first, then key.
  const defs = Object.values(MCPToolDefinitions);
  const tool = defs.find(t => t.name === toolName) || MCPToolDefinitions[toolName];

  if (!tool) {
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    switch (toolName) {
      case 'calendar_check_availability':
        return await checkCalendarAvailability(params, tenantId);

      case 'calendar_create_booking':
        return await createCalendarBooking(params, tenantId);

      // ── LolaDesk native smart booking + memory (the REAL path) ──
      case 'lola_check_availability': {
        const t = await tenantForMCP(tenantId);
        return t ? runBookingAction('check_availability', t, params, { channel: 'voice' }) : { error: 'tenant_not_found' };
      }
      case 'lola_book_appointment': {
        const t = await tenantForMCP(tenantId);
        return t ? runBookingAction('book_appointment', t, params, { channel: 'voice' }) : { error: 'tenant_not_found' };
      }
      case 'lola_reschedule_appointment': {
        const t = await tenantForMCP(tenantId);
        return t ? runBookingAction('reschedule_appointment', t, params, { channel: 'voice' }) : { error: 'tenant_not_found' };
      }
      case 'lola_cancel_appointment': {
        const t = await tenantForMCP(tenantId);
        return t ? runBookingAction('cancel_appointment', t, params, { channel: 'voice' }) : { error: 'tenant_not_found' };
      }
      case 'lola_remember': {
        const t = await tenantForMCP(tenantId);
        return t ? runBookingAction('remember', t, params, {}) : { error: 'tenant_not_found' };
      }
      case 'lola_recall': {
        const t = await tenantForMCP(tenantId);
        return t ? runBookingAction('recall', t, params, {}) : { error: 'tenant_not_found' };
      }

      case 'stripe_charge_client':
        return await chargeStripe(params, tenantId);

      case 'stripe_balance':
        return await getStripeBalance(tenantId);

      case 'crm_update_client':
        return await updateCRMClient(params, tenantId);

      case 'crm_search_client':
        return await searchCRMClient(params, tenantId);

      case 'slack_notify_team':
        return await notifySlack(params, tenantId);

      case 'email_send_client':
        return await sendEmail(params, tenantId);

      case 'sms_send_client':
        return await sendSMS(params, tenantId);

      case 'inventory_check_stock':
        return await checkInventory(params, tenantId);

      case 'analytics_get_metrics':
        return await getAnalyticsMetrics(params, tenantId);

      case 'zapier_trigger_workflow':
        return await triggerZapier(params, tenantId);

      default:
        return { error: 'Tool not implemented' };
    }
  } catch (e) {
    console.error(`[MCP] Tool execution failed:`, e);
    return { error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────
// IMPLEMENTATION STUBS (Connect to your actual backends)
// ─────────────────────────────────────────────────────────────────

async function checkCalendarAvailability(params, tenantId) {
  const tenant = await tenantForMCP(tenantId);
  if(!tenant) return { error: 'tenant_not_found' };
  const r = await runBookingAction('check_availability', tenant, {
    service: params.service, stylist: params.stylist_name, date: params.date
  }, { channel: 'voice' });
  return r.ok ? { slots: r.slots, date: params.date, speak: r.speak } : r;
}

async function createCalendarBooking(params, tenantId) {
  const tenant = await tenantForMCP(tenantId);
  if(!tenant) return { error: 'tenant_not_found' };
  return runBookingAction('book_appointment', tenant, {
    service: params.title || params.service,
    starts_at: params.start_time,
    client_name: params.client_name,
    client_email: params.client_email,
    stylist: params.stylist_name
  }, { channel: 'voice' });
}

async function chargeStripe(params, tenantId) {
  // TODO: Call Stripe API with tenant's secret key
  return { success: true, charge_id: 'ch_12345', amount: params.amount_cents };
}

async function getStripeBalance(tenantId) {
  // TODO: Query Stripe balance
  return { balance_cents: 250000, currency: 'usd' };
}

async function updateCRMClient(params, tenantId) {
  // TODO: Update HubSpot/Salesforce/Pipedrive
  return { success: true, client_id: params.client_id };
}

async function searchCRMClient(params, tenantId) {
  // TODO: Search CRM by phone/email
  return {
    found: true,
    client: { id: 'c_123', name: 'Sarah', email: 'sarah@example.com', lifetime_value: 2400 }
  };
}

async function notifySlack(params, tenantId) {
  // TODO: Post to Slack webhook
  return { success: true, ts: '1234567890.123456' };
}

async function sendEmail(params, tenantId) {
  // TODO: Send via SendGrid/Mailgun/SES
  return { success: true, message_id: 'msg_12345' };
}

async function sendSMS(params, tenantId) {
  // TODO: Send via Telnyx SMS
  return { success: true, message_id: 'sms_12345' };
}

async function checkInventory(params, tenantId) {
  // TODO: Query Shopify/custom inventory
  return { in_stock: true, quantity: 15 };
}

async function getAnalyticsMetrics(params, tenantId) {
  // TODO: Query analytics database
  return { metric: params.metric, value: 245, period: params.time_period };
}

async function triggerZapier(params, tenantId) {
  // TODO: POST to Zapier webhook
  return { success: true, status: 'queued' };
}

export default {
  MCPToolDefinitions,
  buildMCPToolsPrompt,
  executeMCPTool
};
