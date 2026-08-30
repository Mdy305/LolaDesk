-- External booking-platform sync tracking.
-- Lets LolaDesk record which connected platform (Square/Boulevard/Vagaro/
-- Mindbody/Fresha) a booking was also pushed to, and that platform's own
-- appointment ID, so a future reschedule/cancel can be synced out too.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source text;

CREATE INDEX IF NOT EXISTS idx_bookings_external_id ON bookings(external_id) WHERE external_id IS NOT NULL;
