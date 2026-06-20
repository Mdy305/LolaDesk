/**
 * index.ts (functions/notifications)
 * Maps and normalizes incoming client event webhooks (Square, Vagaro, etc.) 
 * to LolaDesk notification schemas, preparing them to be logged in Supabase/db.
 */

export interface NormalizedEvent {
  tenant_id: string;
  type: 'booking' | 'call' | 'lead' | 'message';
  icon: 'calendar' | 'phone' | 'user';
  title: string;
  source: 'square' | 'vagaro' | 'system';
  raw_payload: any;
  created_at: string;
}

/**
 * Normalizes Square booking and customer update webhook payloads.
 */
export function normalizeSquarePayload(tenantId: string, payload: any): NormalizedEvent | null {
  if (!payload || !payload.type) return null;

  const eventType = payload.type;
  const data = payload.data?.object;

  if (eventType.startsWith('booking.')) {
    const booking = data?.booking;
    const serviceName = booking?.appointment_segments?.[0]?.service_variation_name || 'Appointment';
    const status = booking?.status || 'created';
    
    return {
      tenant_id: tenantId,
      type: 'booking',
      icon: 'calendar',
      title: `Square booking ${status} — ${serviceName}`,
      source: 'square',
      raw_payload: payload,
      created_at: new Date().toISOString()
    };
  }

  if (eventType.startsWith('customer.')) {
    const customer = data?.customer;
    const name = customer?.given_name ? `${customer.given_name} ${customer.family_name || ''}`.trim() : 'New Guest';
    
    return {
      tenant_id: tenantId,
      type: 'lead',
      icon: 'user',
      title: `Square customer profile updated — ${name}`,
      source: 'square',
      raw_payload: payload,
      created_at: new Date().toISOString()
    };
  }

  return null;
}

/**
 * Normalizes Vagaro appointment and class webhook payloads.
 */
export function normalizeVagaroPayload(tenantId: string, payload: any): NormalizedEvent | null {
  if (!payload || !payload.EventType) return null;

  const eventType = payload.EventType;
  const appointment = payload.Appointment;

  if (eventType === 'AppointmentCreated' || eventType === 'AppointmentChanged') {
    const serviceName = appointment?.ServiceNames?.[0] || 'Salon Service';
    const clientName = appointment?.ClientName || 'Client';
    const status = eventType === 'AppointmentCreated' ? 'booked' : 'rescheduled';
    
    return {
      tenant_id: tenantId,
      type: 'booking',
      icon: 'calendar',
      title: `Vagaro: ${clientName} ${status} ${serviceName}`,
      source: 'vagaro',
      raw_payload: payload,
      created_at: new Date().toISOString()
    };
  }

  if (eventType === 'AppointmentCancelled') {
    const serviceName = appointment?.ServiceNames?.[0] || 'Service';
    const clientName = appointment?.ClientName || 'Client';
    
    return {
      tenant_id: tenantId,
      type: 'booking',
      icon: 'calendar',
      title: `Vagaro: ${clientName} CANCELLED ${serviceName}`,
      source: 'vagaro',
      raw_payload: payload,
      created_at: new Date().toISOString()
    };
  }

  return null;
}
