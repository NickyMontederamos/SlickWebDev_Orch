-- TCC Integrated Nexus PostgreSQL 16+ / pgvector
-- Safe bootstrap: isolated schemas, idempotent objects, no secrets.
-- Tested on PostgreSQL 16 with pgvector 0.8 (tests/sql/run.sh). Safe to apply more than once.
-- Not included: roles, grants and row-level security. Run the application as a role that
-- does not own these tables, otherwise the append-only triggers can be disabled by that role.
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS aoc;
CREATE SCHEMA IF NOT EXISTS kgh;
CREATE SCHEMA IF NOT EXISTS rimcp;
CREATE SCHEMA IF NOT EXISTS nexus_audit;
CREATE TABLE IF NOT EXISTS aoc.agents (
 agent_id uuid PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL,
 owner_id text NOT NULL, status text NOT NULL CHECK(status IN ('draft','approved','paused','revoked')),
 classification text NOT NULL CHECK(classification IN ('PUBLIC','CONTROLLED','CONFIDENTIAL','RESTRICTED','CLIENT_CONFIDENTIAL')),
 capabilities jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS aoc.connectors (
 connector_id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('mcp','plugin','addon','api')),
 version text NOT NULL, publisher text, checksum text NOT NULL, trust_state text NOT NULL DEFAULT 'quarantine'
 CHECK(trust_state IN ('quarantine','tested','approved','blocked','revoked')), write_enabled boolean NOT NULL DEFAULT false,
 scopes jsonb NOT NULL DEFAULT '[]', config_ref text, UNIQUE(name,version));
CREATE TABLE IF NOT EXISTS aoc.approvals (
 approval_id uuid PRIMARY KEY, request_id uuid NOT NULL, gate text NOT NULL, requested_by text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('pending','approved','denied','expired')) DEFAULT 'pending',
 decided_by text, reason text, requested_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz);
CREATE TABLE IF NOT EXISTS aoc.runtime_events (
 event_id uuid PRIMARY KEY, correlation_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 actor text NOT NULL, agent_id uuid REFERENCES aoc.agents(agent_id), event_type text NOT NULL,
 target text, policy_decision text, result text, duration_ms integer CHECK(duration_ms >= 0), cost_usd numeric(14,6), payload jsonb NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS ix_runtime_correlation ON aoc.runtime_events(correlation_id,occurred_at);
CREATE INDEX IF NOT EXISTS ix_runtime_type_time ON aoc.runtime_events(event_type,occurred_at DESC);
CREATE TABLE IF NOT EXISTS kgh.documents (
 document_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, source_uri text NOT NULL, title text,
 classification text NOT NULL, approval_state text NOT NULL DEFAULT 'pending', content_sha256 text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,content_sha256));
CREATE TABLE IF NOT EXISTS kgh.chunks (
 chunk_id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES kgh.documents(document_id) ON DELETE CASCADE,
 ordinal integer NOT NULL, content text NOT NULL, embedding vector(768), token_count integer,
 metadata jsonb NOT NULL DEFAULT '{}', UNIQUE(document_id,ordinal));
CREATE INDEX IF NOT EXISTS ix_chunks_embedding ON kgh.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS ix_documents_tenant_class ON kgh.documents(tenant_id,classification,approval_state);
CREATE TABLE IF NOT EXISTS kgh.retrieval_evidence (
 evidence_id uuid PRIMARY KEY, correlation_id uuid NOT NULL, query_sha256 text NOT NULL,
 chunk_id uuid REFERENCES kgh.chunks(chunk_id), rank integer NOT NULL, score real,
 policy_snapshot jsonb NOT NULL, cited boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rimcp.revenue_events (
 revenue_event_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, source text NOT NULL, external_ref text,
 event_type text NOT NULL, occurred_at timestamptz NOT NULL, amount numeric(18,4) NOT NULL,
 currency char(3) NOT NULL, campaign_id text, customer_ref_hash text, immutable_payload jsonb NOT NULL,
 ingested_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,source,external_ref));
CREATE INDEX IF NOT EXISTS ix_revenue_tenant_time ON rimcp.revenue_events(tenant_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS rimcp.recommendations (
 recommendation_id uuid PRIMARY KEY, correlation_id uuid NOT NULL, tenant_id uuid NOT NULL,
 recommendation_type text NOT NULL, rationale text NOT NULL, evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','rejected','executed','expired')),
 requires_approval boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
-- authorization_ref: AUTHORIZATION is a reserved word in PostgreSQL and cannot be a bare column name.
CREATE TABLE IF NOT EXISTS nexus_audit.action_ledger (
 sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_id uuid UNIQUE NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, agent text, action text NOT NULL,
 target text, authorization_ref text, policy_decision text, result text, approval_id uuid,
 error_redacted text, rollback_status text, correlation_id uuid NOT NULL, evidence_hash text NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ledger_correlation ON nexus_audit.action_ledger(correlation_id,sequence_id);
CREATE OR REPLACE FUNCTION nexus_audit.prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'action_ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS trg_ledger_append_only ON nexus_audit.action_ledger;
CREATE TRIGGER trg_ledger_append_only BEFORE UPDATE OR DELETE ON nexus_audit.action_ledger
FOR EACH ROW EXECUTE FUNCTION nexus_audit.prevent_ledger_mutation();
-- A row-level trigger does not fire on TRUNCATE, which would otherwise empty the ledger in one statement.
DROP TRIGGER IF EXISTS trg_ledger_no_truncate ON nexus_audit.action_ledger;
CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON nexus_audit.action_ledger
FOR EACH STATEMENT EXECUTE FUNCTION nexus_audit.prevent_ledger_mutation();
CREATE OR REPLACE VIEW aoc.v_connector_risk AS
SELECT name,kind,version,trust_state,write_enabled,jsonb_array_length(scopes) scope_count,
CASE WHEN trust_state<>'approved' THEN 'BLOCK' WHEN write_enabled THEN 'APPROVAL_REQUIRED' ELSE 'READ_ONLY' END action_mode
FROM aoc.connectors;
COMMIT;
