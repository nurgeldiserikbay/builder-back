-- One reminder to the side of a dispute that has not answered.
ALTER TABLE "disputes" ADD COLUMN "reminded_at" TIMESTAMPTZ(3);
