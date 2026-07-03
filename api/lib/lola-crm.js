/**
 * api/lib/lola-crm.js — LOLA™ CRM Integration
 * ═══════════════════════════════════════════════════════════════
 * Client relationship management with:
 * - Client profiles and preferences
 * - Booking history and patterns
 * - Conversation tracking
 * - VIP segmentation
 * - Memory/personalization
 */

import { db } from './db.js';

/**
 * Get comprehensive client insights
 */
export async function getClientInsights(clientId, tenantId) {
  try {
    const result = await db.query(
      `SELECT 
        c.*,
        COUNT(DISTINCT b.id) as total_bookings,
        MAX(b.booking_date) as last_booking_date,
        COUNT(DISTINCT conv.id) as total_conversations,
        AVG(EXTRACT(EPOCH FROM (b.actual_end - b.actual_start))) / 60 as avg_service_duration,
        SUM(b.amount) as total_spent,
        cm.profile_data as client_memory
      FROM clients c
      LEFT JOIN bookings b ON c.id = b.client_id AND b.tenant_id = $1
      LEFT JOIN conversations conv ON c.id = conv.client_id AND conv.tenant_id = $1
      LEFT JOIN client_memories cm ON c.id = cm.client_id AND cm.tenant_id = $1 AND cm.key = 'profile'
      WHERE c.id = $1 AND c.tenant_id = $2
      GROUP BY c.id, cm.profile_data`,
      [tenantId, clientId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const client = result.rows[0];

    // Parse JSON fields
    if (typeof client.client_memory === 'string') {
      try {
        client.client_memory = JSON.parse(client.client_memory);
      } catch {
        client.client_memory = {};
      }
    }

    // Determine VIP status
    client.is_vip = client.total_bookings >= 5 && client.total_spent >= 500;

    // Calculate engagement score (0-100)
    client.engagement_score = calculateEngagementScore(client);

    // Last contact days ago
    const lastContact = client.last_contact || client.created_at;
    client.days_since_contact = Math.floor((Date.now() - new Date(lastContact).getTime()) / (1000 * 60 * 60 * 24));

    return client;
  } catch (error) {
    console.error('[CRM] Get client insights error:', error);
    return null;
  }
}

/**
 * Update client from conversation
 */
export async function updateClientFromConversation(clientId, tenantId, conversationData) {
  try {
    const { intent, mood, response, photoAnalysis, bookingLink } = conversationData;

    // Update last contact
    await db.query(
      `UPDATE clients 
       SET last_contact = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2`,
      [clientId, tenantId]
    );

    // Store mood/sentiment if available
    if (mood) {
      await db.query(
        `INSERT INTO client_mood_history (client_id, tenant_id, mood, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [clientId, tenantId, mood]
      );
    }

    // Store photo analysis if exists
    if (photoAnalysis) {
      await db.query(
        `INSERT INTO photo_analyses (client_id, tenant_id, analysis_data, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [clientId, tenantId, JSON.stringify(photoAnalysis)]
      );
    }

    return { success: true };
  } catch (error) {
    console.error('[CRM] Update client error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get clients needing follow-up
 */
export async function getClientsForFollowUp(tenantId, limit = 50) {
  try {
    const result = await db.query(
      `SELECT 
        c.*,
        COUNT(DISTINCT b.id) as total_bookings,
        MAX(b.booking_date) as last_booking_date,
        EXTRACT(EPOCH FROM (NOW() - c.last_contact)) / 86400 as days_since_contact
      FROM clients c
      LEFT JOIN bookings b ON c.id = b.client_id AND b.tenant_id = $1
      WHERE c.tenant_id = $1
        AND c.last_contact < NOW() - INTERVAL '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM follow_up_queue fq 
          WHERE fq.client_id = c.id AND fq.tenant_id = $1
            AND fq.processed_at IS NULL
        )
      GROUP BY c.id
      ORDER BY c.last_contact ASC
      LIMIT $2`,
      [tenantId, limit]
    );

    return result.rows;
  } catch (error) {
    console.error('[CRM] Get follow-up clients error:', error);
    return [];
  }
}

/**
 * Get VIP clients
 */
export async function getVIPClients(tenantId) {
  try {
    const result = await db.query(
      `SELECT 
        c.*,
        COUNT(DISTINCT b.id) as total_bookings,
        SUM(b.amount) as total_spent,
        MAX(b.booking_date) as last_booking_date
      FROM clients c
      LEFT JOIN bookings b ON c.id = b.client_id AND b.tenant_id = $1
      WHERE c.tenant_id = $1 AND c.vip_status = true
      GROUP BY c.id
      ORDER BY total_spent DESC`,
      [tenantId]
    );

    return result.rows;
  } catch (error) {
    console.error('[CRM] Get VIP clients error:', error);
    return [];
  }
}

/**
 * Get clients by segment
 */
export async function getClientsBySegment(tenantId, segment) {
  try {
    let query = `
      SELECT c.*, COUNT(DISTINCT b.id) as total_bookings
      FROM clients c
      LEFT JOIN bookings b ON c.id = b.client_id AND b.tenant_id = $1
      WHERE c.tenant_id = $1
    `;

    const params = [tenantId];

    // Apply segment filter
    switch (segment) {
      case 'high_value':
        query += ` AND (SELECT SUM(amount) FROM bookings WHERE client_id = c.id AND tenant_id = $1) > 1000`;
        break;

      case 'frequent':
        query += ` AND (SELECT COUNT(*) FROM bookings WHERE client_id = c.id AND tenant_id = $1) >= 5`;
        break;

      case 'inactive':
        query += ` AND c.last_contact < NOW() - INTERVAL '30 days'`;
        break;

      case 'new':
        query += ` AND c.created_at > NOW() - INTERVAL '30 days'`;
        break;

      case 'at_risk':
        query += ` AND c.last_contact < NOW() - INTERVAL '60 days'
                    AND (SELECT COUNT(*) FROM bookings WHERE client_id = c.id AND tenant_id = $1) > 0`;
        break;
    }

    query += ` GROUP BY c.id ORDER BY c.last_contact DESC LIMIT 100`;

    const result = await db.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('[CRM] Get segment error:', error);
    return [];
  }
}

/**
 * Calculate engagement score (0-100)
 */
function calculateEngagementScore(client) {
  let score = 0;

  // Recent contact (max 30 points)
  const daysSinceContact = client.days_since_contact || 999;
  if (daysSinceContact < 7) score += 30;
  else if (daysSinceContact < 14) score += 20;
  else if (daysSinceContact < 30) score += 10;

  // Booking frequency (max 40 points)
  const totalBookings = client.total_bookings || 0;
  if (totalBookings >= 10) score += 40;
  else if (totalBookings >= 5) score += 30;
  else if (totalBookings >= 3) score += 20;
  else if (totalBookings >= 1) score += 10;

  // Conversation activity (max 30 points)
  const totalConversations = client.total_conversations || 0;
  if (totalConversations >= 10) score += 30;
  else if (totalConversations >= 5) score += 20;
  else if (totalConversations >= 1) score += 10;

  return Math.min(score, 100);
}

/**
 * Update client preferences
 */
export async function updateClientPreferences(clientId, tenantId, preferences) {
  try {
    await db.query(
      `UPDATE clients 
       SET preferences = preferences || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(preferences), clientId, tenantId]
    );

    return { success: true };
  } catch (error) {
    console.error('[CRM] Update preferences error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Store client memory/notes
 */
export async function setClientMemory(clientId, tenantId, key, value) {
  try {
    await db.query(
      `INSERT INTO client_memories (client_id, tenant_id, key, value, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (client_id, tenant_id, key) DO UPDATE
       SET value = $4, updated_at = NOW()`,
      [clientId, tenantId, key, JSON.stringify(value)]
    );

    return { success: true };
  } catch (error) {
    console.error('[CRM] Set memory error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get client memory/notes
 */
export async function getClientMemory(clientId, tenantId, key = null) {
  try {
    let query = `SELECT * FROM client_memories WHERE client_id = $1 AND tenant_id = $2`;
    const params = [clientId, tenantId];

    if (key) {
      query += ` AND key = $3`;
      params.push(key);
    }

    const result = await db.query(query, params);

    if (key && result.rows.length > 0) {
      try {
        return JSON.parse(result.rows[0].value);
      } catch {
        return result.rows[0].value;
      }
    }

    return result.rows.map(r => ({
      key: r.key,
      value: tryParseJSON(r.value)
    }));
  } catch (error) {
    console.error('[CRM] Get memory error:', error);
    return null;
  }
}

/**
 * Try to parse JSON safely
 */
function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/**
 * Get client by phone or email
 */
export async function findClientByContact(tenantId, phone = null, email = null) {
  try {
    let query = `SELECT * FROM clients WHERE tenant_id = $1`;
    const params = [tenantId];

    if (phone) {
      query += ` AND phone = $${params.length + 1}`;
      params.push(phone);
    } else if (email) {
      query += ` AND email = $${params.length + 1}`;
      params.push(email);
    }

    const result = await db.query(query, params);
    return result.rows[0] || null;
  } catch (error) {
    console.error('[CRM] Find client error:', error);
    return null;
  }
}

/**
 * Create or update client
 */
export async function upsertClient(tenantId, clientData) {
  try {
    const {
      id,
      phone,
      email,
      name,
      vip_status,
      preferences
    } = clientData;

    if (id) {
      // Update
      const result = await db.query(
        `UPDATE clients 
         SET phone = COALESCE($1, phone),
             email = COALESCE($2, email),
             name = COALESCE($3, name),
             vip_status = COALESCE($4, vip_status),
             preferences = COALESCE($5, preferences),
             updated_at = NOW()
         WHERE id = $6 AND tenant_id = $7
         RETURNING *`,
        [phone, email, name, vip_status, preferences ? JSON.stringify(preferences) : null, id, tenantId]
      );

      return result.rows[0] || null;
    } else {
      // Insert
      const result = await db.query(
        `INSERT INTO clients (tenant_id, phone, email, name, vip_status, preferences, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (tenant_id, COALESCE(phone, '')) DO UPDATE
         SET email = COALESCE($3, email),
             name = COALESCE($4, name),
             updated_at = NOW()
         RETURNING *`,
        [tenantId, phone, email, name, vip_status || false, preferences ? JSON.stringify(preferences) : null]
      );

      return result.rows[0] || null;
    }
  } catch (error) {
    console.error('[CRM] Upsert client error:', error);
    return null;
  }
}

export default {
  getClientInsights,
  updateClientFromConversation,
  getClientsForFollowUp,
  getVIPClients,
  getClientsBySegment,
  updateClientPreferences,
  setClientMemory,
  getClientMemory,
  findClientByContact,
  upsertClient
};
