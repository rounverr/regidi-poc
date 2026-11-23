-- Rename the timestamp without losing the one-row counters or historical values.
-- SQLite updates references in lab_count_step_1/2/3 triggers automatically.
ALTER TABLE lab_metrics RENAME COLUMN last_interaction_at_arg TO last_interaction_at;
