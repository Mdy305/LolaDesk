-- Migration: create orchestrator_audit and jobs tables
-- Run in Supabase SQL Editor or via migrations pipeline

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Audit table for raw LLM outputs and validation results
CREATE TABLE IF NOT EXISTS orchestrator_audit (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  prompt TEXT,
  llm_output JSONB,
  valid BOOLEAN DEFAULT FALSE,
  errors TEXT[],
  validated_at TIMESTAMPTZ
);

-- Jobs table for background processing (TTS, demo calls, connector writes)
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, succeeded, failed
  attempts INT NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_idx ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
