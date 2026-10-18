-- Section 12-13 closure correction: allow restricted safety escalation Tasks
-- to remain explicitly unassigned until an authorized safety admin is available.
ALTER TABLE "tasks"
  ALTER COLUMN "assigneeId" DROP NOT NULL;
