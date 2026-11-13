-- A screenshot or PDF attached to a dispute message.
ALTER TABLE "dispute_messages" ADD COLUMN "file_name" VARCHAR(200), ADD COLUMN "file_mime" VARCHAR(40), ADD COLUMN "file_bytes" INTEGER, ADD COLUMN "file_sha256" VARCHAR(64), ADD COLUMN "file_data" BYTEA;
