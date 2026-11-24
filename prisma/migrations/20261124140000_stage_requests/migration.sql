-- «Заявки на этап»: the owner describes the work, specialists from the catalog respond with terms.
CREATE TABLE "stage_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "role" "StageAssignmentRole" NOT NULL,
  "description" VARCHAR(2000) NOT NULL,
  "pay_kind" VARCHAR(10) NOT NULL,
  "budget_tiyn" INTEGER,
  "days" INTEGER NOT NULL,
  "status" VARCHAR(12) NOT NULL DEFAULT 'open',
  "closes_at" TIMESTAMPTZ(3) NOT NULL,
  "chosen_response_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stage_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stage_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stage_requests_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stage_requests_pay_kind_check" CHECK ("pay_kind" IN ('fixed', 'hourly', 'any')),
  CONSTRAINT "stage_requests_status_check" CHECK ("status" IN ('open', 'filled', 'cancelled')),
  CONSTRAINT "stage_requests_days_check" CHECK ("days" BETWEEN 1 AND 180)
);
CREATE INDEX "stage_requests_open_idx" ON "stage_requests" ("status", "closes_at");
CREATE INDEX "stage_requests_project_idx" ON "stage_requests" ("project_id");
-- One open request per stage and role: a second one would split the responses.
CREATE UNIQUE INDEX "stage_requests_one_open_key" ON "stage_requests" ("stage_id", "role") WHERE "status" = 'open';

CREATE TABLE "stage_request_responses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,
  "specialist_user_id" UUID NOT NULL,
  "message" VARCHAR(1000) NOT NULL,
  "pay_kind" VARCHAR(10) NOT NULL,
  "fixed_amount_tiyn" INTEGER,
  "hourly_rate_tiyn" INTEGER,
  "hour_limit" INTEGER,
  "days" INTEGER NOT NULL,
  "status" VARCHAR(12) NOT NULL DEFAULT 'sent',
  "assignment_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stage_request_responses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stage_request_responses_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "stage_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stage_request_responses_specialist_user_id_fkey" FOREIGN KEY ("specialist_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stage_request_responses_pay_kind_check" CHECK ("pay_kind" IN ('fixed', 'hourly')),
  CONSTRAINT "stage_request_responses_status_check" CHECK ("status" IN ('sent', 'chosen', 'declined', 'withdrawn'))
);
CREATE UNIQUE INDEX "stage_request_responses_once_key" ON "stage_request_responses" ("request_id", "specialist_user_id");
CREATE INDEX "stage_request_responses_specialist_idx" ON "stage_request_responses" ("specialist_user_id");
