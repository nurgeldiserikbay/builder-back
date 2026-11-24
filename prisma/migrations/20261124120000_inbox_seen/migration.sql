-- «Входящие»: when the person last opened the updates feed; later events by others count as new.
ALTER TABLE "users" ADD COLUMN "inbox_seen_at" TIMESTAMPTZ(3);
