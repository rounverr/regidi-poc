-- Aggregate counters for completed interactions in Regidi Lab.
-- Exactly one row, no IPs, visitor identifiers, agents, or event history.
CREATE TABLE IF NOT EXISTS lab_metrics (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  step_1_count INTEGER NOT NULL DEFAULT 0 CHECK (step_1_count >= 0),
  step_2_count INTEGER NOT NULL DEFAULT 0 CHECK (step_2_count >= 0),
  step_3_count INTEGER NOT NULL DEFAULT 0 CHECK (step_3_count >= 0),
  last_interaction_at_arg TEXT
) STRICT;

INSERT INTO lab_metrics (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Step 1: a newly created agent session, after successful Turnstile validation.
CREATE TRIGGER IF NOT EXISTS lab_count_step_1 AFTER INSERT ON lab_sessions
BEGIN
  UPDATE lab_metrics
  SET step_1_count = step_1_count + 1,
      last_interaction_at_arg = strftime('%Y-%m-%dT%H:%M:%S-03:00', 'now', '-3 hours')
  WHERE id = 1;
END;

-- Step 2: every newly issued grant, including repeats in the same session.
CREATE TRIGGER IF NOT EXISTS lab_count_step_2 AFTER UPDATE OF grant_id ON lab_sessions
WHEN NEW.grant_id IS NOT NULL AND (OLD.grant_id IS NULL OR OLD.grant_id <> NEW.grant_id)
BEGIN
  UPDATE lab_metrics
  SET step_2_count = step_2_count + 1,
      last_interaction_at_arg = strftime('%Y-%m-%dT%H:%M:%S-03:00', 'now', '-3 hours')
  WHERE id = 1;
END;

-- Step 3: each newly consumed cryptographic proof. Receiver-policy denials count.
-- Bad signatures and replayed proofs do not, because they are not consumed.
CREATE TRIGGER IF NOT EXISTS lab_count_step_3 AFTER INSERT ON lab_used_proofs
BEGIN
  UPDATE lab_metrics
  SET step_3_count = step_3_count + 1,
      last_interaction_at_arg = strftime('%Y-%m-%dT%H:%M:%S-03:00', 'now', '-3 hours')
  WHERE id = 1;
END;
