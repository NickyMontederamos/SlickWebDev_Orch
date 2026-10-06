-- Behavioural checks for sql/TCC_Integrated_Nexus_Schema.sql. Any failed check raises and stops psql.
-- Run through tests/sql/run.sh, which supplies a throwaway database.

CREATE FUNCTION pg_temp.must_fail(stmt text, expect text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%' || expect || '%' THEN
      RAISE EXCEPTION 'wrong error for [%]: %', stmt, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'statement should have been refused: %', stmt;
END $$;

CREATE FUNCTION pg_temp.must_be(label text, got text, want text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '%: got %, wanted %', label, got, want; END IF;
END $$;

-- one-hot 768-dimension vector with the 1 at position k
CREATE FUNCTION pg_temp.unit(k int) RETURNS vector LANGUAGE sql IMMUTABLE AS $$
  SELECT array_agg(CASE WHEN g = k THEN 1 ELSE 0 END ORDER BY g)::vector FROM generate_series(1, 768) g
$$;

-- ---------- objects ----------
SELECT pg_temp.must_be('schemas', (SELECT count(*)::text FROM information_schema.schemata WHERE schema_name IN ('aoc','kgh','rimcp','nexus_audit')), '4');
SELECT pg_temp.must_be('tables', (SELECT count(*)::text FROM information_schema.tables WHERE table_schema IN ('aoc','kgh','rimcp','nexus_audit') AND table_type = 'BASE TABLE'), '10');
SELECT pg_temp.must_be('views', (SELECT count(*)::text FROM information_schema.views WHERE table_schema = 'aoc'), '1');
SELECT pg_temp.must_be('ledger triggers', (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'nexus_audit.action_ledger'::regclass AND NOT tgisinternal), 'trg_ledger_append_only,trg_ledger_no_truncate');
SELECT pg_temp.must_be('vector index method', (SELECT am.amname::text FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.relname = 'ix_chunks_embedding'), 'hnsw');

-- ---------- nexus_audit: the ledger is append-only ----------
INSERT INTO nexus_audit.action_ledger(event_id, actor, action, authorization_ref, correlation_id, evidence_hash)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'owner', 'approve', 'approval:1', gen_random_uuid(), 'sha256:a'),
       ('00000000-0000-0000-0000-0000000000a2', 'hermes', 'execute', 'approval:1', gen_random_uuid(), 'sha256:b');
SELECT pg_temp.must_be('ledger sequence is ordered', (SELECT string_agg(action, '>' ORDER BY sequence_id) FROM nexus_audit.action_ledger), 'approve>execute');
SELECT pg_temp.must_fail($$UPDATE nexus_audit.action_ledger SET actor = 'x'$$, 'append-only');
SELECT pg_temp.must_fail($$DELETE FROM nexus_audit.action_ledger$$, 'append-only');
SELECT pg_temp.must_fail($$TRUNCATE nexus_audit.action_ledger$$, 'append-only');
SELECT pg_temp.must_fail($$INSERT INTO nexus_audit.action_ledger(event_id, actor, action, correlation_id, evidence_hash) VALUES ('00000000-0000-0000-0000-0000000000a1', 'a', 'b', gen_random_uuid(), 'h')$$, 'duplicate key');
SELECT pg_temp.must_fail($$INSERT INTO nexus_audit.action_ledger(sequence_id, event_id, actor, action, correlation_id, evidence_hash) VALUES (1, gen_random_uuid(), 'a', 'b', gen_random_uuid(), 'h')$$, 'non-DEFAULT value');
SELECT pg_temp.must_fail($$INSERT INTO nexus_audit.action_ledger(event_id, actor, action, correlation_id) VALUES (gen_random_uuid(), 'a', 'b', gen_random_uuid())$$, 'evidence_hash');
SELECT pg_temp.must_be('ledger rows survive', (SELECT count(*)::text FROM nexus_audit.action_ledger), '2');

-- ---------- aoc: connectors start quarantined, the risk view decides the mode ----------
INSERT INTO aoc.connectors(connector_id, name, kind, version, checksum) VALUES (gen_random_uuid(), 'github', 'mcp', '1.0.0', 'sha256:x');
INSERT INTO aoc.connectors(connector_id, name, kind, version, checksum, trust_state, scopes) VALUES (gen_random_uuid(), 'postgres', 'mcp', '1.0.0', 'sha256:y', 'approved', '["read"]');
INSERT INTO aoc.connectors(connector_id, name, kind, version, checksum, trust_state, write_enabled, scopes) VALUES (gen_random_uuid(), 'slack', 'mcp', '1.0.0', 'sha256:z', 'approved', true, '["draft","send"]');
SELECT pg_temp.must_be('new connector is quarantined and read-only', (SELECT trust_state || '/' || write_enabled FROM aoc.connectors WHERE name = 'github'), 'quarantine/false');
SELECT pg_temp.must_be('risk view', (SELECT string_agg(name || '=' || action_mode || ':' || scope_count, ' ' ORDER BY name) FROM aoc.v_connector_risk), 'github=BLOCK:0 postgres=READ_ONLY:1 slack=APPROVAL_REQUIRED:2');
SELECT pg_temp.must_fail($$INSERT INTO aoc.connectors(connector_id, name, kind, version, checksum) VALUES (gen_random_uuid(), 'x', 'webhook', '1', 'c')$$, 'check constraint');
SELECT pg_temp.must_fail($$INSERT INTO aoc.connectors(connector_id, name, kind, version, checksum) VALUES (gen_random_uuid(), 'github', 'mcp', '1.0.0', 'c')$$, 'duplicate key');
SELECT pg_temp.must_fail($$UPDATE aoc.connectors SET trust_state = 'trusted'$$, 'check constraint');

INSERT INTO aoc.agents(agent_id, code, name, owner_id, status, classification) VALUES ('00000000-0000-0000-0000-0000000000b1', 'audit', 'Audit Agent', 'owner', 'approved', 'CONTROLLED');
SELECT pg_temp.must_fail($$INSERT INTO aoc.agents(agent_id, code, name, owner_id, status, classification) VALUES (gen_random_uuid(), 'x', 'X', 'o', 'active', 'PUBLIC')$$, 'check constraint');
SELECT pg_temp.must_fail($$INSERT INTO aoc.agents(agent_id, code, name, owner_id, status, classification) VALUES (gen_random_uuid(), 'x', 'X', 'o', 'draft', 'SECRET')$$, 'check constraint');
SELECT pg_temp.must_fail($$INSERT INTO aoc.agents(agent_id, code, name, owner_id, status, classification) VALUES (gen_random_uuid(), 'audit', 'X', 'o', 'draft', 'PUBLIC')$$, 'duplicate key');

INSERT INTO aoc.approvals(approval_id, request_id, gate, requested_by) VALUES (gen_random_uuid(), gen_random_uuid(), 'launch', 'deployment-agent');
SELECT pg_temp.must_be('approval starts pending', (SELECT decision FROM aoc.approvals), 'pending');
SELECT pg_temp.must_fail($$UPDATE aoc.approvals SET decision = 'auto-approved'$$, 'check constraint');

INSERT INTO aoc.runtime_events(event_id, correlation_id, actor, agent_id, event_type, duration_ms) VALUES (gen_random_uuid(), gen_random_uuid(), 'hermes', '00000000-0000-0000-0000-0000000000b1', 'tool_call', 120);
SELECT pg_temp.must_fail($$INSERT INTO aoc.runtime_events(event_id, correlation_id, actor, event_type, duration_ms) VALUES (gen_random_uuid(), gen_random_uuid(), 'h', 't', -1)$$, 'check constraint');
SELECT pg_temp.must_fail($$INSERT INTO aoc.runtime_events(event_id, correlation_id, actor, agent_id, event_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'h', gen_random_uuid(), 't')$$, 'foreign key');

-- ---------- kgh: documents, chunks, vector search, cited evidence ----------
INSERT INTO kgh.documents(document_id, tenant_id, source_uri, classification, content_sha256)
VALUES ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'file://a.md', 'CONTROLLED', 'sha-a'),
       ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f1', 'file://b.md', 'CONTROLLED', 'sha-b');
INSERT INTO kgh.chunks(chunk_id, document_id, ordinal, content, embedding)
SELECT ('00000000-0000-0000-0000-00000000c00' || k)::uuid, '00000000-0000-0000-0000-0000000000d1', k, 'chunk ' || k, pg_temp.unit(k) FROM generate_series(1, 3) k;
INSERT INTO kgh.chunks(chunk_id, document_id, ordinal, content, embedding) VALUES ('00000000-0000-0000-0000-00000000c009', '00000000-0000-0000-0000-0000000000d2', 1, 'other', pg_temp.unit(9));
SELECT pg_temp.must_be('nearest chunk by cosine distance', (SELECT content FROM kgh.chunks ORDER BY embedding <=> pg_temp.unit(2) LIMIT 1), 'chunk 2');
DO $$
DECLARE line text; plan text := '';
BEGIN
  SET LOCAL enable_seqscan = off;
  FOR line IN EXECUTE 'EXPLAIN SELECT chunk_id FROM kgh.chunks ORDER BY embedding <=> pg_temp.unit(2) LIMIT 1' LOOP plan := plan || line; END LOOP;
  IF plan NOT LIKE '%ix_chunks_embedding%' THEN RAISE EXCEPTION 'vector index is not usable for cosine search: %', plan; END IF;
END $$;
SELECT pg_temp.must_fail($$INSERT INTO kgh.chunks(chunk_id, document_id, ordinal, content, embedding) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000d1', 7, 'bad', '[1,2,3]')$$, 'expected 768 dimensions');
SELECT pg_temp.must_fail($$INSERT INTO kgh.chunks(chunk_id, document_id, ordinal, content) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000d1', 1, 'dup')$$, 'duplicate key');
SELECT pg_temp.must_fail($$INSERT INTO kgh.documents(document_id, tenant_id, source_uri, classification, content_sha256) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'file://copy.md', 'CONTROLLED', 'sha-a')$$, 'duplicate key');
SELECT pg_temp.must_be('new document waits for approval', (SELECT DISTINCT approval_state FROM kgh.documents), 'pending');
INSERT INTO kgh.retrieval_evidence(evidence_id, correlation_id, query_sha256, chunk_id, rank, score, policy_snapshot, cited)
VALUES (gen_random_uuid(), gen_random_uuid(), 'q', '00000000-0000-0000-0000-00000000c002', 1, 0.99, '{"corpus":"approved"}', true);
-- A document whose chunk has been cited as evidence cannot be deleted; an uncited one can, and its chunks go with it.
SELECT pg_temp.must_fail($$DELETE FROM kgh.documents WHERE document_id = '00000000-0000-0000-0000-0000000000d1'$$, 'foreign key');
DELETE FROM kgh.documents WHERE document_id = '00000000-0000-0000-0000-0000000000d2';
SELECT pg_temp.must_be('chunks follow their document', (SELECT count(*)::text FROM kgh.chunks), '3');

-- ---------- rimcp: revenue events and draft-only recommendations ----------
INSERT INTO rimcp.revenue_events(revenue_event_id, tenant_id, source, external_ref, event_type, occurred_at, amount, currency, immutable_payload)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'stripe', 'in_1', 'invoice.paid', now(), 499.00, 'USD', '{}');
SELECT pg_temp.must_fail($$INSERT INTO rimcp.revenue_events(revenue_event_id, tenant_id, source, external_ref, event_type, occurred_at, amount, currency, immutable_payload) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'stripe', 'in_1', 'invoice.paid', now(), 499.00, 'USD', '{}')$$, 'duplicate key');
SELECT pg_temp.must_fail($$INSERT INTO rimcp.revenue_events(revenue_event_id, tenant_id, source, external_ref, event_type, occurred_at, amount, currency, immutable_payload) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'stripe', 'in_2', 'invoice.paid', now(), 1, 'USDT', '{}')$$, 'too long');
INSERT INTO rimcp.recommendations(recommendation_id, correlation_id, tenant_id, recommendation_type, rationale, evidence) VALUES (gen_random_uuid(), gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'upsell', 'observed need', '[]');
SELECT pg_temp.must_be('recommendation starts as a draft that needs approval', (SELECT status || '/' || requires_approval FROM rimcp.recommendations), 'draft/true');
SELECT pg_temp.must_fail($$UPDATE rimcp.recommendations SET status = 'sent'$$, 'check constraint');
-- Known limit, recorded so a change is noticed: without an external_ref the same event can be stored twice.
INSERT INTO rimcp.revenue_events(revenue_event_id, tenant_id, source, event_type, occurred_at, amount, currency, immutable_payload)
SELECT gen_random_uuid(), '00000000-0000-0000-0000-0000000000f1', 'manual', 'payment', '2026-01-01', 10, 'USD', '{}' FROM generate_series(1, 2);
SELECT pg_temp.must_be('known limit: repeats allowed when external_ref is empty', (SELECT count(*)::text FROM rimcp.revenue_events WHERE source = 'manual'), '2');
