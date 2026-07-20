import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { tenantId, clients, document } = await req.json();

    if (!tenantId) {
      return NextResponse.json({ error: 'Missing tenantId' }, { status: 400 });
    }

    // 1. Bulk Upsert Clients from CSV Data
    if (clients && Array.isArray(clients) && clients.length > 0) {
      const formattedClients = clients.map((c) => ({
        tenant_id: tenantId,
        first_name: c.firstName || c.name?.split(' ')[0] || 'Unknown',
        last_name: c.lastName || c.name?.split(' ').slice(1).join(' ') || '',
        phone: c.phone || null,
        email: c.email || null,
        preferred_service: c.preferredService || null,
        status: c.status || 'active',
      }));

      const { error: upsertError } = await supabase
        .from('clients')
        .upsert(formattedClients, { onConflict: 'tenant_id, phone' });

      if (upsertError) throw upsertError;
    }

    // 2. Attach File Record (PDF / Image / Profile Attachment)
    if (document) {
      const { clientId, fileName, fileUrl, fileType } = document;
      const { error: docError } = await supabase.from('client_documents').insert({
        tenant_id: tenantId,
        client_id: clientId,
        file_name: fileName,
        file_url: fileUrl,
        file_type: fileType,
      });

      if (docError) throw docError;
    }

    return NextResponse.json({
      success: true,
      message: 'Clients and attachments successfully imported.',
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
