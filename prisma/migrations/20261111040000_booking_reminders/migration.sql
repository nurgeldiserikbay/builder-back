-- E-mail reminders for clients who leave an address when booking.
ALTER TABLE "bookings"
  ADD COLUMN "client_email" VARCHAR(254),
  ADD COLUMN "reminder_at" TIMESTAMPTZ(3),
  ADD COLUMN "reminder_status" VARCHAR(10),
  ADD COLUMN "cancel_link_sealed" TEXT,
  ADD CONSTRAINT "bookings_reminder_status_check" CHECK ("reminder_status" IS NULL OR "reminder_status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'));

CREATE INDEX "bookings_reminder_due_idx" ON "bookings" ("reminder_status", "reminder_at");
