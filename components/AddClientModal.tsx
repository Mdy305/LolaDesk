'use client';

import React, { useState } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

interface AddClientModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenantId: string;
  onRefresh?: () => void;
}

export default function AddClientModal({
  isOpen,
  onClose,
  tenantId,
  onRefresh,
}: AddClientModalProps) {
  const supabase = createClientComponentClient();
  const [activeTab, setActiveTab] = useState<'single' | 'csv'>('single');
  const [loading, setLoading] = useState(false);

  // Single Client Form State
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [preferredService, setPreferredService] = useState('');
  const [file, setFile] = useState<File | null>(null);

  // CSV File State
  const [csvFile, setCsvFile] = useState<File | null>(null);

  if (!isOpen) return null;

  // Single Client Submission & File Upload
  const handleSingleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      let uploadedUrl = null;

      // Upload Attachment to Supabase Storage if present
      if (file) {
        const filePath = `${tenantId}/${Date.now()}_${file.name}`;
        const { data, error } = await supabase.storage
          .from('client-documents')
          .upload(filePath, file);

        if (error) throw error;

        const { data: publicUrlData } = supabase.storage
          .from('client-documents')
          .getPublicUrl(data.path);

        uploadedUrl = publicUrlData.publicUrl;
      }

      // Create Client
      const { data: newClient, error: clientError } = await supabase
        .from('clients')
        .insert({
          tenant_id: tenantId,
          first_name: firstName,
          last_name: lastName,
          phone,
          email,
          preferred_service: preferredService,
          status: 'active',
        })
        .select('id')
        .single();

      if (clientError) throw clientError;

      // Link File Metadata if uploaded
      if (uploadedUrl && newClient) {
        await fetch('/api/clients/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tenantId,
            document: {
              clientId: newClient.id,
              fileName: file?.name,
              fileUrl: uploadedUrl,
              fileType: file?.type,
            },
          }),
        });
      }

      if (onRefresh) onRefresh();
      onClose();
    } catch (err: any) {
      alert(err.message || 'Error adding client');
    } finally {
      setLoading(false);
    }
  };

  // CSV Parsing & Bulk Import
  const handleCsvSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csvFile) return;

    setLoading(true);
    const reader = new FileReader();

    reader.onload = async (evt) => {
      try {
        const text = evt.target?.result as string;
        const lines = text.split('\n');
        const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());

        const clients = lines.slice(1).filter((line) => line.trim() !== '').map((line) => {
          const values = line.split(',').map((v) => v.trim());
          return {
            firstName: values[headers.indexOf('firstname')] || values[0] || '',
            lastName: values[headers.indexOf('lastname')] || values[1] || '',
            phone: values[headers.indexOf('phone')] || values[2] || '',
            email: values[headers.indexOf('email')] || values[3] || '',
            preferredService: values[headers.indexOf('service')] || values[4] || '',
          };
        });

        const res = await fetch('/api/clients/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantId, clients }),
        });

        if (!res.ok) throw new Error('Failed to import CSV');

        if (onRefresh) onRefresh();
        onClose();
      } catch (err: any) {
        alert(err.message || 'Error processing CSV');
      } finally {
        setLoading(false);
      }
    };

    reader.readAsText(csvFile);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-2xl dark:bg-zinc-900 dark:text-white">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">Add New Client</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {/* Tab Selection */}
        <div className="flex border-b border-gray-200 dark:border-zinc-800 mb-6">
          <button
            className={`pb-2 px-4 text-sm font-medium ${
              activeTab === 'single'
                ? 'border-b-2 border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'text-gray-500'
            }`}
            onClick={() => setActiveTab('single')}
          >
            Manual Entry / File
          </button>
          <button
            className={`pb-2 px-4 text-sm font-medium ${
              activeTab === 'csv'
                ? 'border-b-2 border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'text-gray-500'
            }`}
            onClick={() => setActiveTab('csv')}
          >
            Bulk CSV Upload
          </button>
        </div>

        {/* Form: Single Entry */}
        {activeTab === 'single' ? (
          <form onSubmit={handleSingleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <input
                type="text"
                placeholder="First Name"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full rounded-lg border p-2 text-sm dark:bg-zinc-800 dark:border-zinc-700"
              />
              <input
                type="text"
                placeholder="Last Name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full rounded-lg border p-2 text-sm dark:bg-zinc-800 dark:border-zinc-700"
              />
            </div>
            <input
              type="tel"
              placeholder="Phone (+1...)"
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border p-2 text-sm dark:bg-zinc-800 dark:border-zinc-700"
            />
            <input
              type="email"
              placeholder="Email Address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border p-2 text-sm dark:bg-zinc-800 dark:border-zinc-700"
            />
            <input
              type="text"
              placeholder="Preferred Service (e.g. Balayage)"
              value={preferredService}
              onChange={(e) => setPreferredService(e.target.value)}
              className="w-full rounded-lg border p-2 text-sm dark:bg-zinc-800 dark:border-zinc-700"
            />
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Attach Document / Photo / Hair Profile
              </label>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="w-full text-xs text-gray-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                {loading ? 'Saving...' : 'Save Client'}
              </button>
            </div>
          </form>
        ) : (
          /* Form: CSV Import */
          <form onSubmit={handleCsvSubmit} className="space-y-4">
            <div className="rounded-lg border-2 border-dashed p-6 text-center dark:border-zinc-700">
              <input
                type="file"
                accept=".csv"
                onChange={(e) => setCsvFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-500"
              />
              <p className="mt-2 text-xs text-gray-400">
                CSV header format: <code>firstName, lastName, phone, email, service</code>
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !csvFile}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                {loading ? 'Importing...' : 'Upload & Import CSV'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
